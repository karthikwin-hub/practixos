import { createHmac, timingSafeEqual } from "node:crypto";

export interface PaymentIntent {
  uri: string;
  qr: string;
}

export interface BillingPort {
  intent(reference: string, amountPaise: number): PaymentIntent;
  verify(rawBody: Buffer, signature: string): boolean;
}

/** Signed local settlement. Does not call a payment provider. */
export function localBilling(secret: string): BillingPort {
  return {
    intent(reference, amountPaise) {
      const rupees = (amountPaise / 100).toFixed(2);
      return {
        uri: `upi://pay?pa=practixos-test@upi&am=${rupees}&tn=${reference}`,
        qr: reference,
      };
    },
    verify(rawBody, signature) {
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
  };
}

export function closedBilling(): BillingPort {
  return {
    intent() {
      throw Object.assign(new Error("payment credentials are not configured"), { statusCode: 503 });
    },
    verify() {
      return false;
    },
  };
}

export function signBody(secret: string, raw: Buffer | string): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}
