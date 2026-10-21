/**
 * The owner: the one human this personal tool serves. sweatshop is
 * single-user, but not single-OWNER — `SWEATSHOP_OWNER_NAME` says who
 * that is (default "Chad", the author's deployment). Every user-facing
 * string interpolates these so a different owner reads themselves, not
 * Chad.
 *
 * Read per call (no module-level caching) so tests and env reloads see
 * changes immediately.
 */
export function ownerName(): string {
  return process.env.SWEATSHOP_OWNER_NAME?.trim() || "Chad";
}

/** `Chad's` / `James'` — the possessive of the owner's name. */
export function possessive(name: string = ownerName()): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/**
 * `{{owner}}` / `{{owner's}}` placeholders in shipped/stored prompt text
 * (sections, skill bodies), rendered at TURN time — never baked in at
 * seed/save time — so changing `SWEATSHOP_OWNER_NAME` retargets every
 * existing section and skill instantly instead of freezing whoever was
 * the owner when the text was written.
 */
export function renderOwnerPlaceholders(text: string): string {
  const name = ownerName();
  return text.replaceAll("{{owner's}}", possessive(name)).replaceAll("{{owner}}", name);
}
