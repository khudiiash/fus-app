/**
 * Wall-clock duration (ms) of the teleport-to-flag channel. Both client UI progress
 * and server-side cooldown use this value, so changing it requires RTDB-rule review
 * if the window length drifts from 15s materially.
 */
export const FUS_LABY_FLAG_CHANNEL_MS = 15_000;
