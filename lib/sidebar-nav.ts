/**
 * 0040: which sidebar page row a pathname lights. Pure so the rule is
 * testable without rendering. `/p/<id>` (a project's own page) is inside
 * Projects; everything else matches by its top-level segment.
 */
export type NavPage =
  | "inbox"
  | "prs"
  | "projects"
  | "sandboxes"
  | "previews"
  | "settings"
  | "changelog";

const SEGMENT: Record<string, NavPage> = {
  inbox: "inbox",
  prs: "prs",
  projects: "projects",
  p: "projects",
  sandboxes: "sandboxes",
  previews: "previews",
  settings: "settings",
  changelog: "changelog",
};

export function activeNavPage(pathname: string): NavPage | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return (segment && SEGMENT[segment]) || null;
}
