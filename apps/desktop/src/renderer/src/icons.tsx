// The app's line icons, from Lucide (two panels reshaped below), under the names the app calls them by.
// Size and stroke width come from `.ic` in styles/app.css; the widths there are in
// Lucide's 24-unit grid.
import markOnDark from "../../../../../assets/brand/app/finxwork-mark-on-dark-256.png";
import markOnLight from "../../../../../assets/brand/app/finxwork-mark-on-light-256.png";
import markSolid from "../../../../../assets/brand/mark/finxwork-mark-solid.svg";
import { animateMark, rewriteStrip, type MarkMotionOptions } from "../../../../../assets/brand/motion/finxwork-mark-motion.js";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightFromLine,
  ArrowRightToLine,
  ArrowUp,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  CodeXml,
  Copy,
  CornerDownRight,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileText,
  Folder,
  FolderPlus,
  FolderTree,
  GitBranch,
  Globe,
  Grid2x2,
  GripVertical,
  Info,
  Key,
  Languages,
  Laptop,
  Layers,
  List,
  ListCollapse,
  ListFilter,
  Lock,
  LockOpen,
  LogOut,
  Maximize2,
  MessageSquare,
  MessagesSquare,
  Minimize2,
  Minus,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Plug,
  Plus,
  RotateCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Play,
  Quote,
  Square,
  SquareFunction,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Undo2,
  Unlink,
  Upload,
  User,
  X,
  Zap,
  createLucideIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

// Lucide's panel-left and panel-right flattened to sit beside the traffic lights: 14 × 12 at 16 px with
// `.tb .ic.panel`'s 1 px stroke, every straight line on a 2x screen's pixels.
const panel = (name: string, divider: number) =>
  createLucideIcon(name, [
    ["rect", { x: 2.25, y: 3.75, width: 19.5, height: 16.5, rx: 2, key: "frame" }],
    ["path", { d: `M${divider} 3.75v16.5`, key: "divider" }],
  ]);
const PanelLeft = panel("panel-left-flat", 8.25);
const PanelRight = panel("panel-right-flat", 15.75);

const icons = {
  eye: Eye,
  eyeOff: EyeOff,
  search: Search,
  sidebar: PanelLeft,
  gear: Settings,
  bell: Bell,
  plus: Plus,
  doc: FileText,
  list: List,
  more: Ellipsis,
  x: X,
  // Trace precedents and dependents, and their arrows cleared; a formula; saving (the workbook grid).
  tracePre: ArrowRightToLine,
  traceDep: ArrowRightFromLine,
  traceOff: Unlink,
  fx: SquareFunction,
  check: Check,
  save: Save,
  undo: Undo2,
  // A workbook: a sheet's cells.
  grid: Grid2x2,
  minus: Minus,
  chevD: ChevronDown,
  chevR: ChevronRight,
  chevL: ChevronLeft,
  updown: ChevronsUpDown,
  stop: Square,
  play: Play,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  archive: Archive,
  infoCard: PanelRight,
  sessionInfo: ListCollapse,
  info: Info,
  laptop: Laptop,
  tree: FolderTree,
  folder: Folder,
  folderPlus: FolderPlus,
  code: CodeXml,
  file: File,
  key: Key,
  person: User,
  terminal: SquareTerminal,
  copy: Copy,
  quote: Quote,
  ext: ExternalLink,
  edit: Pencil,
  clock: Clock,
  steer: CornerDownRight,
  shield: ShieldCheck,
  lock: Lock,
  unlock: LockOpen,
  logout: LogOut,
  warn: TriangleAlert,
  bolt: Zap,
  sparkle: Sparkles,
  paperclip: Paperclip,
  retry: RotateCw,
  filter: ListFilter,
  cube: Box,
  bot: Bot,
  pin: Pin,
  chats: MessagesSquare,
  layers: Layers,
  pause: Pause,
  blocks: Blocks,
  skill: BookOpen,
  plug: Plug,
  globe: Globe,
  translate: Languages,
  grip: GripVertical,
  upload: Upload,
  chat: MessageSquare,
  trash: Trash2,
  expand: Maximize2,
  shrink: Minimize2,
  branch: GitBranch,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const Glyph = icons[name];
  return <Glyph className={`ic ${className}`} aria-hidden="true" />;
}

/** finxwork's mark, the α of assets/brand: the data-point mark from 64 px up, the solid one below (the brand's smallest size for each). */
export function Mark({ size = 18 }: { size?: number }) {
  const style = { display: "block", flex: "none", width: size, height: size };
  if (size < 64) return <img src={markSolid} alt="" draggable={false} style={style} />;
  return (
    <picture style={{ display: "contents" }}>
      <source srcSet={markOnDark} media="(prefers-color-scheme: dark)" />
      <img src={markOnLight} alt="" draggable={false} style={style} />
    </picture>
  );
}

/** The mark in motion (assets/brand/motion): its data points flowing along the stroke. The "strands" look from 96 px up, "solid" below; sized by `size` or by CSS through className. */
export function MarkMotion({ size, className, theme, look, speed, intro, rewrite }: MarkMotionOptions & { size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const motion = rewrite ? rewriteStrip(ref.current!, { theme }) : animateMark(ref.current!, { theme, look, speed, intro });
    return () => motion.stop();
  }, [theme, look, speed, intro, rewrite]);
  const box = size ? { display: "block", flex: "none", width: size, height: size } : undefined;
  if (rewrite) return <span className={`mark-strip ${className ?? ""}`} aria-hidden="true" style={{ ...box, overflow: "hidden" }}><canvas ref={ref} /></span>;
  return <canvas ref={ref} className={className} aria-hidden="true" style={box} />;
}
