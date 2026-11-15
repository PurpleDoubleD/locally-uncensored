/**
 * Which phone shows a shared chat (D8, Discord 02.11.; updated M310). The LU
 * phone app reads shared chats since 3.0.10, under Remote desktop. The
 * browser remote only sends chats started on the phone to this computer.
 */
export const SHARED_CHATS_PHONE_NOTE = 'Shared chats show up in the LU phone app (3.0.10 or newer) under Remote desktop. The browser remote does not show them.'

/** The same, with what the browser remote does. */
export const SHARED_CHATS_PHONE_NOTE_LONG = `${SHARED_CHATS_PHONE_NOTE} In the browser remote, chats started on the phone reach this computer, but what you write here does not go back to the phone.`
