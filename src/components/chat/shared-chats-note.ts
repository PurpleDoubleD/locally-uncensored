/**
 * Which phone shows a shared chat (D8, Discord 02.11.). Only the next LU
 * phone app reads shared chats; the phone app 3.0.7 and the browser remote
 * only send chats started on the phone to this computer. Remove these lines
 * when the phone app with shared chats is out.
 */
export const SHARED_CHATS_PHONE_NOTE = "Shared chats show up in the next LU phone app. The phone app 3.0.7 and the browser remote don't show them yet."

/** The same, with what reaches the phone until then. */
export const SHARED_CHATS_PHONE_NOTE_LONG = `${SHARED_CHATS_PHONE_NOTE} Until then, chats started on the phone reach this computer, but what you write here does not go back to the phone.`
