import { signBody } from "../billing/index.js";

export interface CalendarPush {
  appointmentId: string;
  start: string;
  end: string;
  title: string;
}

export interface CalendarPort {
  push(event: CalendarPush): Promise<{ id: string }>;
  verify(rawBody: Buffer, signature: string): boolean;
}

/** Records a calendar payload. Does not call Google or Microsoft. */
export function localCalendar(secret: string): CalendarPort {
  return {
    async push(event) {
      return { id: `cal_${event.appointmentId}` };
    },
    verify(rawBody, signature) {
      return signBody(secret, rawBody) === signature;
    },
  };
}

export function closedCalendar(): CalendarPort {
  return {
    async push() {
      throw Object.assign(new Error("calendar credentials are not configured"), { statusCode: 503 });
    },
    verify() {
      return false;
    },
  };
}
