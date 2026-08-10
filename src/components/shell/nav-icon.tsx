import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpenCheck,
  ChartColumnBig,
  CircleDot,
  FileSpreadsheet,
  IdCard,
  Landmark,
  LayoutDashboard,
  MessageSquareText,
  Package,
  ReceiptIndianRupee,
  Settings,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Truck,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/**
 * Explicit registry.
 *
 * Resolving icon names against the whole lucide namespace would pull every
 * icon into the client bundle; this map keeps it to the ones actually rendered.
 */
const ICONS: Record<string, LucideIcon> = {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpenCheck,
  ChartColumnBig,
  FileSpreadsheet,
  IdCard,
  Landmark,
  LayoutDashboard,
  MessageSquareText,
  Package,
  ReceiptIndianRupee,
  Settings,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Truck,
  UserPlus,
  Users,
  Wallet,
};

/**
 * Renders a navigation icon by name.
 *
 * A component rather than a `navIcon(name)` helper that callers assign to a
 * capitalised variable: the latter reads to the React Compiler as creating a
 * component inside render, which it flags because such a component would
 * remount on every pass. Doing the lookup inside a stable component avoids
 * that entirely.
 */
export function NavIcon({
  name,
  ...props
}: LucideProps & { name: string }) {
  const Icon = ICONS[name] ?? CircleDot;
  return <Icon {...props} />;
}
