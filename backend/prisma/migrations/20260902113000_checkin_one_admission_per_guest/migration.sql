-- One admission row per guest at a time: closes the reissue-after-check-in
-- double-admission gap. (Voiding deletes the row, so re-admission remains
-- possible after a supervisor correction.)
CREATE UNIQUE INDEX "CheckIn_guestId_key" ON "CheckIn"("guestId");
