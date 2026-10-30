/** Pointer activation already targets a visible row; keyboard navigation may need a reveal. */
export function revealSidebarRow(row: HTMLElement | null): void {
  if (row !== null && !row.matches(":hover")) row.scrollIntoView({ block: "nearest" });
}
