import {
  BookOpenCheck,
  ChartColumnBig,
  FileSpreadsheet,
  Landmark,
  MessageSquareText,
  Package,
  ReceiptIndianRupee,
  Scale,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * Explicit icon registry.
 *
 * Looking icons up by string from the full lucide namespace would pull every
 * icon into the client bundle. This map keeps the import graph to the handful
 * actually rendered.
 */
const ICONS: Record<string, LucideIcon> = {
  BookOpenCheck,
  ChartColumnBig,
  FileSpreadsheet,
  Landmark,
  MessageSquareText,
  Package,
  ReceiptIndianRupee,
  Scale,
  ShieldCheck,
  TrendingUp,
  Truck,
  Users,
};

export function getFeatureIcon(name: string): LucideIcon {
  return ICONS[name] ?? Sparkles;
}
