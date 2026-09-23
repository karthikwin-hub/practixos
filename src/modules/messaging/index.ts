import { randomUUID } from "node:crypto";

export interface OutboundMessage {
  to: string;
  lang: string;
  template: string;
  body: string;
  channel: "whatsapp" | "sms";
}

export interface MessagingPort {
  dispatch(message: OutboundMessage): Promise<{ receiptId: string; channel: "whatsapp" | "sms" }>;
}

/** Records a delivery receipt. Does not call Meta. */
export function localMessaging(): MessagingPort {
  return {
    async dispatch(message) {
      return { receiptId: `rcpt_${randomUUID()}`, channel: message.channel };
    },
  };
}

export function closedMessaging(): MessagingPort {
  return {
    async dispatch() {
      throw Object.assign(new Error("messaging credentials are not configured"), { statusCode: 503 });
    },
  };
}
