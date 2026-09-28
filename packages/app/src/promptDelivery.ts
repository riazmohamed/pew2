/** Manual sends may queue; automatic voice instructions must never wait in an outbox. */
export type PromptDeliveryPolicy = "queue" | "online-only";

export function promptDelivery(sent: boolean, policy: PromptDeliveryPolicy = "queue"): "sent" | "queue" | "refused" {
  if (sent) return "sent";
  return policy === "online-only" ? "refused" : "queue";
}
