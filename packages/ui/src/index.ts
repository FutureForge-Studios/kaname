/* ------------------------------------------------------------------ *
 * @kaname/ui
 *
 * The shared component system. Every module in the product builds from
 * these; nothing forks a one-off variant. If a page needs a behaviour
 * that is not here, the component here grows a prop.
 * ------------------------------------------------------------------ */

export { cn, variant, type VariantMap } from "./lib/cn.js";
export {
  useFloating,
  type Placement,
  type UseFloatingOptions,
  type UseFloatingResult,
} from "./hooks/useFloating.js";

/* --------------------------- primitives ---------------------------- */
export * from "./components/Button.js";
export * from "./components/Input.js";
export * from "./components/Textarea.js";
export * from "./components/Select.js";
export * from "./components/Combobox.js";
export * from "./components/Checkbox.js";
export * from "./components/Switch.js";
export * from "./components/FormField.js";
export * from "./components/Kbd.js";

/* ---------------------------- overlays ----------------------------- */
export * from "./components/Portal.js";
export * from "./components/Popover.js";
export * from "./components/Tooltip.js";
export * from "./components/DropdownMenu.js";
export * from "./components/Dialog.js";
export * from "./components/Drawer.js";
export * from "./components/Tabs.js";
export * from "./components/Toast.js";
export * from "./components/Layout.js";

/* ----------------------------- display ----------------------------- */
export * from "./components/Badge.js";
export * from "./components/Status.js";
export * from "./components/JobStatus.js";
export * from "./components/Avatar.js";
export * from "./components/Feedback.js";
export * from "./components/EmptyState.js";
export * from "./components/ErrorState.js";
export * from "./components/Page.js";
export * from "./components/PropertyList.js";
export * from "./components/Primitives.js";
export * from "./components/MetricTile.js";

/* ------------------------------ data ------------------------------- */
export * from "./components/DataTable.js";
export * from "./components/Charts.js";
export * from "./components/TimeRangePicker.js";
export * from "./components/LogViewer.js";
export * from "./components/FileTree.js";
