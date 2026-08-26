import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeftRight,
  AtSign,
  BadgeCheck,
  Box,
  CircleSlash,
  Cog,
  Database,
  FileSearch,
  Folder,
  Forward,
  Globe,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LineChart,
  Link2,
  ListChecks,
  Mail,
  Network,
  PackageCheck,
  Rocket,
  ScrollText,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  UserCog,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import type { CommandCenterSummary } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Icon registry.
 *
 * NAVIGATION and the search API both name their icon as a string,
 * because the contract package cannot import React. Resolving those
 * names in exactly one place keeps the sidebar, the breadcrumb trail
 * and the command palette drawing the same glyph for the same thing.
 * ------------------------------------------------------------------ */

export type IconComponent = ComponentType<{ size?: number | string; className?: string }>;

const ICONS: Record<string, IconComponent> = {
  Activity,
  Archive,
  ArrowLeftRight,
  AtSign,
  BadgeCheck,
  Box,
  Cog,
  Database,
  FileSearch,
  Folder,
  Forward,
  Globe,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LineChart,
  Link2,
  ListChecks,
  Mail,
  Network,
  Rocket,
  ScrollText,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  UserCog,
  Users,
  Webhook,
  Zap,
};

/** Unknown names fall back to a neutral glyph rather than a blank cell. */
export function iconFor(name: string | null | undefined): IconComponent {
  if (!name) return CircleSlash;
  return ICONS[name] ?? CircleSlash;
}

type AttentionKind = CommandCenterSummary["attention"][number]["kind"];

/** One glyph per reason a row can appear on the attention list. */
export const ATTENTION_ICONS: Record<AttentionKind, IconComponent> = {
  agent_offline: Server,
  disk_pressure: HardDrive,
  cert_expiring: ShieldCheck,
  backup_failed: Archive,
  service_failed: Cog,
  mail_auth_failing: BadgeCheck,
  threat_spike: ShieldAlert,
  job_failed: AlertTriangle,
  update_available: PackageCheck,
};
