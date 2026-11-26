#!/usr/bin/env node
// A scripted A2A 1.0 peer for transport tests (docs/kernel/bot-contacts-design.md §5, §9).
// Dependency-free ESM. Wire format follows appendix B.2.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const API_KEY = 'test-key';
const BASIC = 'Basic ' + Buffer.from('test-user:' + API_KEY).toString('base64');
const args = process.argv.slice(2);

function usage(message) {
  process.stderr.write(`${message}\nusage: node server.mjs [--port N] [--host H] [--auth | --basic] [--no-streaming] [--provider] [--icon]\n`);
  process.exit(2);
}

let portOption;
let host;
// 'none', 'key' (X-API-Key) or 'basic' (test-user / test-key). POST /control/auth/<mode> changes it.
let auth = 'none';
let streaming = true;
let provider = false;
let icon = false;
let images = false;

for (let i = 0; i < args.length; i += 1) {
  switch (args[i]) {
    case '--port': portOption = Number(args[++i]); break;
    case '--host': host = args[++i]; break;
    case '--auth': auth = 'key'; break;
    case '--basic': auth = 'basic'; break;
    case '--no-streaming': streaming = false; break;
    case '--provider': provider = true; break;
    case '--icon': icon = true; break;
    case '--images': images = true; break;
    default: usage(`unknown argument: ${args[i]}`);
  }
}
if (portOption !== undefined && (!Number.isInteger(portOption) || portOption < 0)) usage('--port needs a non-negative integer');
if (host === '') usage('--host needs a value');

const publicUrl = new URL(process.env.PUBLIC_URL || 'http://localhost:9999');
const endpointPath = publicUrl.pathname === '/' ? '/a2a' : publicUrl.pathname;
const listenPort = portOption ?? (publicUrl.port ? Number(publicUrl.port) : publicUrl.protocol === 'https:' ? 443 : 80);
if (host) publicUrl.hostname = host;
if (portOption) publicUrl.port = String(portOption);

// ---------------------------------------------------------------- state

/** contextId -> { users: string[] } */
const contexts = new Map();
/** taskId -> task */
const tasks = new Map();

function contextFor(id) {
  let context = contexts.get(id);
  if (!context) {
    context = { users: [] };
    contexts.set(id, context);
  }
  return context;
}

function newTask(contextId) {
  const task = {
    id: randomUUID(),
    contextId,
    state: 'TASK_STATE_SUBMITTED',
    statusMessage: null,
    artifacts: [],
    finished: false,
    awaiting: false,
    stream: null,
  };
  tasks.set(task.id, task);
  return task;
}

const now = () => new Date().toISOString();

function statusOf(task, state = task.state, message = task.statusMessage) {
  const status = { state, timestamp: now() };
  if (message) status.message = message;
  return status;
}

function taskJson(task) {
  const task_ = {
    id: task.id,
    contextId: task.contextId,
    status: statusOf(task),
  };
  if (task.artifacts.length) task_.artifacts = task.artifacts;
  return task_;
}

function agentMessage(text) {
  return { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] };
}

// ---------------------------------------------------------------- wire

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function rpcError(id, reason, message) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32001,
      message,
      data: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason,
        domain: 'a2a-protocol.org',
        metadata: {},
      }],
    },
  };
}

function fail(res, id, reason, message) {
  json(res, 200, rpcError(id, reason, message));
}

function safeWrite(res, text) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(text);
    return true;
  } catch {
    return false;
  }
}

function emit(res, id, result) {
  safeWrite(res, `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.socket?.setNoDelay(true);
}

function sendTask(res, id, task) {
  emit(res, id, { task: taskJson(task) });
}

function sendStatus(res, id, task, state, message) {
  task.state = state;
  if (message !== undefined) task.statusMessage = message;
  emit(res, id, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: statusOf(task, state, message) } });
}

function sendArtifactText(res, id, task, text) {
  const artifactId = randomUUID();
  task.artifacts = [{ artifactId, name: 'response', parts: [{ text }] }];
  const fragments = text.match(/(?:\S+\s*){1,3}/g) ?? [''];

  fragments.forEach((fragment, index) => {
    const update = {
      taskId: task.id,
      contextId: task.contextId,
      artifact: { artifactId, name: 'response', parts: [{ text: fragment }] },
    };
    if (index > 0) update.append = true;
    emit(res, id, { artifactUpdate: update });
  });
  emit(res, id, {
    artifactUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      artifact: { artifactId, name: 'response', parts: [{ text: '' }] },
      append: true,
      lastChunk: true,
    },
  });
}

function complete(res, id, task, text) {
  task.finished = true;
  sendStatus(res, id, task, 'TASK_STATE_COMPLETED', text ? agentMessage(text) : null);
}

// ---------------------------------------------------------------- files

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64');
const BIG = Buffer.alloc(1024 * 1024, 0x20).toString('base64');

function fileParts(text) {
  switch (text) {
    case 'file':
      return [{ raw: PDF, mediaType: 'application/pdf', filename: 'fake.pdf' }];
    case 'file2':
      return [{ raw: PDF, mediaType: 'application/pdf', filename: '../../x' }];
    case 'file-url':
      return [{ url: 'https://example.com/fake.pdf', mediaType: 'application/pdf', filename: 'fake.pdf' }];
    case 'file-data':
      return [{ data: { hello: 'world', n: 1 }, mediaType: 'application/json' }];
    case 'file-big':
      return [{ raw: BIG, mediaType: 'application/pdf', filename: 'big.pdf' }];
    default:
      return null;
  }
}

// ---------------------------------------------------------------- scenarios

function firstText(message) {
  const part = (message.parts ?? []).find((p) => typeof p?.text === 'string');
  return part ? part.text : '';
}

function helloReply(text, context) {
  const count = context.users.length;
  let reply = `hello (${count})`;
  const earlier = context.users.slice(0, -1);
  if (earlier.length && /what did i|what have i|what was my|remember|said before|之前|刚才|记得/.test(text)) {
    reply += `; you said: ${earlier.join(' / ')}`;
  }
  return reply;
}

function streamReply(res, id, task, reply) {
  sendStatus(res, id, task, 'TASK_STATE_WORKING');
  sendArtifactText(res, id, task, reply);
  complete(res, id, task, reply);
  res.end();
}

function handleStreaming(req, res, id, params) {
  const message = params.message ?? {};
  const text = firstText(message).trim();
  const lower = text.toLowerCase();
  const suppliedContext = message.contextId ?? params.contextId;
  const suppliedTask = message.taskId ?? params.taskId;

  if (suppliedContext === 'old-context') return fail(res, id, 'TASK_NOT_FOUND', 'Task not found');

  let task = null;
  if (suppliedTask) {
    task = tasks.get(suppliedTask);
    if (!task) return fail(res, id, 'TASK_NOT_FOUND', 'Task not found');
  }
  const contextId = task ? task.contextId : suppliedContext || randomUUID();
  const context = contextFor(contextId);
  if (text) context.users.push(text);
  if (!task) task = newTask(contextId);

  openSse(res);
  task.stream = { res, id };
  res.on('close', () => {
    if (task.stream?.res === res) task.stream = null;
  });

  if (task.awaiting) {
    task.awaiting = false;
    const reply = `thanks, ${text || 'ok'}`;
    return streamReply(res, id, task, reply);
  }

  sendTask(res, id, task);

  if (task.finished) {
    sendStatus(res, id, task, task.state, task.statusMessage);
    return res.end();
  }

  const parts = fileParts(lower);
  if (parts) {
    task.state = 'TASK_STATE_WORKING';
    sendStatus(res, id, task, 'TASK_STATE_WORKING');
    task.artifacts = [{ artifactId: randomUUID(), name: 'files', parts }];
    emit(res, id, {
      artifactUpdate: {
        taskId: task.id,
        contextId: task.contextId,
        artifact: task.artifacts[0],
        lastChunk: true,
      },
    });
    complete(res, id, task, null);
    return res.end();
  }

  switch (lower) {
    case 'ask':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      task.awaiting = true;
      sendStatus(res, id, task, 'TASK_STATE_INPUT_REQUIRED', agentMessage('What is your name?'));
      return res.end();

    case 'empty':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      complete(res, id, task, null);
      return res.end();

    case 'fail':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      task.finished = true;
      sendStatus(res, id, task, 'TASK_STATE_FAILED', agentMessage('the fake failed'));
      return res.end();

    case 'reject':
      task.finished = true;
      sendStatus(res, id, task, 'TASK_STATE_REJECTED', null);
      return res.end();

    case 'auth':
      return streamReply(res, id, task, helloReply(lower, context));

    case 'auth-midway':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      task.finished = true;
      sendStatus(res, id, task, 'TASK_STATE_AUTH_REQUIRED', agentMessage('authentication required'));
      return res.end();

    case 'unknown':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      emit(res, id, {
        statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status: { state: 'TASK_STATE_SOMETHING_NEW', timestamp: now() },
        },
      });
      return streamReply(res, id, task, helloReply(lower, context));

    case 'drop': {
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      const artifactId = randomUUID();
      const reply = 'drop reply';
      task.artifacts = [{ artifactId, name: 'response', parts: [{ text: reply }] }];
      task.dropResume = { artifactId, reply };
      emit(res, id, { artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: { artifactId, name: 'response', parts: [{ text: 'drop' }] } } });
      emit(res, id, { artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: { artifactId, name: 'response', parts: [{ text: 'reply' }] }, append: true } });
      setTimeout(() => {
        task.stream = null;
        res.socket?.destroy();
      }, 30);
      return;
    }

    case 'hang':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      return; // connection stays open

    case 'cancel-me':
      sendStatus(res, id, task, 'TASK_STATE_WORKING');
      return; // waits for CancelTask

    default:
      return streamReply(res, id, task, helloReply(lower, context));
  }
}

function handleSendMessage(req, res, id, params) {
  const message = params.message ?? {};
  const text = firstText(message).trim();
  const lower = text.toLowerCase();
  const suppliedContext = message.contextId ?? params.contextId;
  if (suppliedContext === 'old-context') return fail(res, id, 'TASK_NOT_FOUND', 'Task not found');

  const contextId = suppliedContext || randomUUID();
  const context = contextFor(contextId);
  if (text) context.users.push(text);
  const task = newTask(contextId);

  const reply = lower === 'nostream' ? `nostream (${context.users.length})` : helloReply(lower, context);
  const parts = lower === 'nostream'
    ? reply.split(/\s+/).filter(Boolean).map((word) => ({ text: word }))
    : [{ text: reply }];
  task.artifacts = [{ artifactId: randomUUID(), name: 'response', parts }];
  task.state = 'TASK_STATE_COMPLETED';
  task.statusMessage = agentMessage(reply);
  task.finished = true;
  json(res, 200, { jsonrpc: '2.0', id, result: { task: taskJson(task) } });
}

function taskIdFrom(params) {
  return params.id ?? params.taskId;
}

function handleGetTask(req, res, id, params) {
  const task = tasks.get(taskIdFrom(params));
  if (!task) return fail(res, id, 'TASK_NOT_FOUND', 'Task not found');
  json(res, 200, { jsonrpc: '2.0', id, result: taskJson(task) });
}

function handleCancelTask(req, res, id, params) {
  const task = tasks.get(taskIdFrom(params));
  if (!task) return fail(res, id, 'TASK_NOT_FOUND', 'Task not found');
  if (task.finished) return fail(res, id, 'TASK_NOT_CANCELABLE', 'Task not cancelable');

  task.finished = true;
  task.state = 'TASK_STATE_CANCELED';
  if (task.stream) {
    const stream = task.stream;
    task.stream = null;
    sendStatus(stream.res, stream.id, task, 'TASK_STATE_CANCELED', null);
    stream.res.end();
  }
  json(res, 200, { jsonrpc: '2.0', id, result: taskJson(task) });
}

function handleSubscribe(req, res, id, params) {
  const task = tasks.get(taskIdFrom(params));
  if (!task) return fail(res, id, 'TASK_NOT_FOUND', 'Task not found');
  if (task.finished) return fail(res, id, 'UNSUPPORTED_OPERATION', 'Unsupported operation');

  openSse(res);
  task.stream = { res, id };
  res.on('close', () => {
    if (task.stream?.res === res) task.stream = null;
  });
  sendTask(res, id, task);

  // A task whose stream was dropped finishes here; the empty final chunk lets the
  // client close the artifact it was already accumulating.
  if (task.dropResume) {
    const { artifactId } = task.dropResume;
    emit(res, id, {
      artifactUpdate: {
        taskId: task.id,
        contextId: task.contextId,
        artifact: { artifactId, name: 'response', parts: [{ text: '' }] },
        append: true,
        lastChunk: true,
      },
    });
    complete(res, id, task, task.dropResume.reply);
    task.dropResume = null;
    return res.end();
  }
}

// ---------------------------------------------------------------- card

function cardFor(interfaceUrl) {
  const card = {
    name: 'A2A Fake',
    description: 'A scripted A2A 1.0 peer for transport tests.',
    version: '1.0.0',
    supportedInterfaces: [{ url: interfaceUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming },
    defaultInputModes: images ? ['text/plain', 'image/png', 'image/jpeg'] : ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/pdf'],
    skills: [
      { id: 'echo', name: 'Echo', description: 'Answers hello and remembers what was said.', tags: ['test'] },
      { id: 'files', name: 'Files', description: 'Returns inline files, URLs and structured data.', tags: ['test'] },
    ],
  };
  if (provider) card.provider = { organization: 'A2A Fake', url: 'https://example.com' };
  if (icon) card.iconUrl = `${publicUrl.origin}/icon.png`;
  if (auth === 'basic') {
    card.securitySchemes = { pw: { httpAuthSecurityScheme: { scheme: 'Basic' } } };
    card.securityRequirements = [{ schemes: { pw: { list: [] } } }];
  } else if (auth === 'key') {
    card.securitySchemes = { key: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } } };
    card.securityRequirements = [{ schemes: { key: { list: [] } } }];
  }
  return card;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function interfaceUrl() {
  return publicUrl.origin + endpointPath;
}

// ---------------------------------------------------------------- http

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRpc(req, res) {
  const allowed = auth === 'none'
    || (auth === 'key' && req.headers['x-api-key'] === API_KEY)
    || (auth === 'basic' && req.headers.authorization === BASIC);
  if (!allowed) {
    return json(res, 401, rpcError(null, 'AUTH_REQUIRED', 'Authentication required'));
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  const id = body?.id ?? null;
  if (!req.headers['a2a-version']) {
    return fail(res, id, 'VERSION_NOT_SUPPORTED', 'Version not supported');
  }

  const params = body?.params ?? {};
  switch (body?.method) {
    case 'SendStreamingMessage':
      if (!streaming) return fail(res, id, 'UNSUPPORTED_OPERATION', 'Unsupported operation');
      return handleStreaming(req, res, id, params);
    case 'SendMessage': return handleSendMessage(req, res, id, params);
    case 'GetTask': return handleGetTask(req, res, id, params);
    case 'CancelTask': return handleCancelTask(req, res, id, params);
    case 'SubscribeToTask': return handleSubscribe(req, res, id, params);
    default: return fail(res, id, 'UNSUPPORTED_OPERATION', 'Unsupported operation');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, publicUrl.origin);
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      return json(res, 200, cardFor(interfaceUrl()));
    }
    const control = url.pathname.match(/^\/control\/auth\/(none|key|basic)$/);
    if (req.method === 'POST' && control) {
      auth = control[1];
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/card-elsewhere') {
      return json(res, 200, cardFor('http://example.com/a2a'));
    }
    if (req.method === 'GET' && url.pathname === '/bad-card') {
      return json(res, 200, { hello: 'not a card' });
    }
    if (req.method === 'GET' && url.pathname === '/redirect') {
      res.writeHead(302, { Location: 'http://example.com/' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/icon.png' && icon) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      return res.end(PNG);
    }
    if (
      req.method === 'POST'
      && (url.pathname === '/' || url.pathname === '/a2a' || url.pathname === endpointPath)
    ) {
      return await handleRpc(req, res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (error) {
    process.stderr.write(`request failed: ${error?.stack ?? error}\n`);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
    else res.destroy();
  }
});

server.listen(listenPort, host || publicUrl.hostname, () => {
  if (listenPort === 0) publicUrl.port = String(server.address().port);
  const publicBase = publicUrl.pathname === '/' ? publicUrl.origin : publicUrl.origin + publicUrl.pathname;
  process.stdout.write(`listening on ${publicBase}\n`);
});