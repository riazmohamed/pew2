/**
 * Where the new-chat sheet opens, and what the project pill does.
 *
 * Pure (no React Native) so `bun test` can read it. The gap it closes: a folder
 * the agent has never been used in is reachable only through the sheet's
 * folder browser, and the sheet used to open only from the top bar's compose
 * button, which exists only inside a conversation.
 */

/** The sheet's first step: the browser when asked for and available, else the cards. */
export function openingStep(startInBrowse: boolean, canBrowse: boolean): "choices" | "browse" {
  return startInBrowse && canBrowse ? "browse" : "choices";
}

/**
 * What tapping the context bar's project pill does.
 *
 * On an empty new conversation the useful act is choosing where it goes (and
 * there is nothing to measure yet), so the pill picks a project. Inside a
 * conversation the project is fixed, so it shows the details as before. GG
 * Goals has no free-standing chat, so its pill keeps the details too.
 */
export function projectPillAction(input: {
  sessionId?: string;
  loadingSession: boolean;
  goals: boolean;
}): "choose" | "details" {
  return !input.sessionId && !input.loadingSession && !input.goals ? "choose" : "details";
}
