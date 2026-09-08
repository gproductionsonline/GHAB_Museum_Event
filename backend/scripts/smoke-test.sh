#!/bin/bash
set -e
BASE=http://localhost:4000/api/v1
JQ="jq -c"

step() { echo ""; echo "=== $1 ==="; }

step "1. Login (admin)"
ADMIN_TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@ghab.gov","password":"ChangeMe123!"}' | jq -r .token)
echo "admin token: ${ADMIN_TOKEN:0:24}…"
SCANNER_TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"email":"scanner@ghab.gov","password":"ChangeMe123!"}' | jq -r .token)
STAFF_TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"email":"staff@ghab.gov","password":"ChangeMe123!"}' | jq -r .token)

step "2. Events list"
EVENTS=$(curl -s $BASE/events -H "Authorization: Bearer $ADMIN_TOKEN")
EVENT_ID=$(echo "$EVENTS" | jq -r '.events[0].id')
echo "event: $(echo "$EVENTS" | jq -r '.events[0].name') ($EVENT_ID)"

step "3. Import preview"
PREVIEW=$(curl -s -X POST $BASE/import/preview -H "Authorization: Bearer $ADMIN_TOKEN" -F "eventId=$EVENT_ID" -F "file=@.data/test-guests.csv")
echo "$PREVIEW" | jq '{totalRows, validRows, errorCount, skippedRows}'
BATCH_ID=$(echo "$PREVIEW" | jq -r .batchId)

step "4. Import commit"
COMMIT=$(curl -s -X POST $BASE/import/$BATCH_ID/commit -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json')
echo "$COMMIT" | jq .

step "5. Guest list (first page)"
GUESTS=$(curl -s "$BASE/guests?eventId=$EVENT_ID&pageSize=50" -H "Authorization: Bearer $ADMIN_TOKEN")
echo "total guests (incl companions): $(echo "$GUESTS" | jq -r .total)"
echo "$GUESTS" | jq -r '.guests[:4][] | "\(.name) [\(.category)] cred=\(.credential.status // "NONE")"'

step "6. Guest detail + QR"
GUEST_ID=$(echo "$GUESTS" | jq -r '[.guests[] | select(.category=="VIP" and .isCompanion==false) | .id][0]')
DETAIL=$(curl -s $BASE/guests/$GUEST_ID -H "Authorization: Bearer $ADMIN_TOKEN")
CODE=$(echo "$DETAIL" | jq -r '.guest.qr.code')
echo "VIP guest: $(echo "$DETAIL" | jq -r '.guest.firstName') — code: $CODE"
echo "companions: $(echo "$DETAIL" | jq -r '.guest.companions[] | .name')"

step "7. Email credential (outbox fallback)"
curl -s -X POST $BASE/guests/$GUEST_ID/credential/email -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' | jq .
ls .data/outbox | head -2

step "8. Scanner: snapshot download"
SNAP=$(curl -s "$BASE/sync/snapshot?eventId=$EVENT_ID" -H "Authorization: Bearer $SCANNER_TOKEN")
echo "snapshot attendees: $(echo "$SNAP" | jq '.attendees | length') (count $(echo "$SNAP" | jq -r .counts.active))"

step "9. Scan valid QR"
SCAN1=$(curl -s -X POST $BASE/checkin/scan -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"code\":\"$CODE\",\"gate\":\"VIP Gate\",\"deviceName\":\"Test Phone\"}")
echo "$SCAN1" | jq '{result, guest: .guest.displayName}'

step "10. Scan same QR again (duplicate)"
SCAN2=$(curl -s -X POST $BASE/checkin/scan -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"code\":\"$CODE\",\"gate\":\"VIP Gate\"}")
echo "$SCAN2" | jq '{result, guest: .guest.displayName}'

step "11. Scan garbage code (invalid)"
curl -s -X POST $BASE/checkin/scan -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"code\":\"GHAB1.WRONGCODE12345678\"}" | jq .

step "12. Reissue credential, old code -> INVALID, new code -> CHECKED_IN"
NEW=$(curl -s -X POST $BASE/guests/$GUEST_ID/credential/reissue -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"reason":"lost phone"}')
DETAIL2=$(curl -s $BASE/guests/$GUEST_ID -H "Authorization: Bearer $ADMIN_TOKEN")
NEW_CODE=$(echo "$DETAIL2" | jq -r '.guest.qr.code')
echo "old code: $CODE / new code: $NEW_CODE"
curl -s -X POST $BASE/checkin/scan -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"code\":\"$CODE\"}" | jq '{result}'
curl -s -X POST $BASE/checkin/scan -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"code\":\"$NEW_CODE\",\"gate\":\"VIP Gate\"}" | jq '{result, guest: .guest.displayName}'

step "13. Offline batch sync (2 queued scans)"
G2=$(echo "$GUESTS" | jq -r '.guests[] | select(.category=="OFFICIAL") | .id')
D2=$(curl -s $BASE/guests/$G2 -H "Authorization: Bearer $ADMIN_TOKEN")
C2=$(echo "$D2" | jq -r '.guest.qr.code')
G3=$(echo "$GUESTS" | jq -r '.guests[] | select(.category=="MEDIA" and .isCompanion==false) | .id')
D3=$(curl -s $BASE/guests/$G3 -H "Authorization: Bearer $ADMIN_TOKEN")
C3=$(echo "$D3" | jq -r '.guest.qr.code')
SYNC=$(curl -s -X POST $BASE/sync/checkins -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"deviceId\":\"dev-01\",\"deviceName\":\"Gate Tablet\",\"items\":[{\"localId\":\"q1\",\"code\":\"$C2\",\"gate\":\"Main Entrance\",\"clientTimestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},{\"localId\":\"q2\",\"code\":\"$C3\",\"gate\":\"Main Entrance\"}]}")
echo "$SYNC" | jq '{applied, duplicate, rejected}'

step "14. Undo the MEDIA check-in (supervisor)"
CI_ID=$(curl -s "$BASE/checkin/recent?eventId=$EVENT_ID&limit=10" -H "Authorization: Bearer $STAFF_TOKEN" | jq -r '.checkIns[] | select(.category=="MEDIA") | .id')
curl -s -X POST $BASE/checkin/undo -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' -d "{\"checkInId\":\"$CI_ID\"}" | jq .

step "15. Manual check-in (guest without email: Elena Rowe)"
G5=$(echo "$GUESTS" | jq -r '.guests[] | select(.lastName=="Rowe" and .isCompanion==false) | .id')
curl -s -X POST $BASE/checkin/manual -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"guestId\":\"$G5\",\"gate\":\"Main Entrance\"}" | jq '{result, guest: .guest.displayName}'

step "16. Stats"
curl -s "$BASE/stats?eventId=$EVENT_ID" -H "Authorization: Bearer $STAFF_TOKEN" | jq '{totals, byCategory}'

step "17. Cancel a guest -> scan should say GUEST_CANCELLED"
G4=$(echo "$GUESTS" | jq -r '.guests[] | select(.lastName=="Osei" and .isCompanion==false) | .id')
curl -s -X POST $BASE/guests/$G4/cancel -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"reason":"cannot attend"}' | jq -c .
D4=$(curl -s $BASE/guests/$G4 -H "Authorization: Bearer $ADMIN_TOKEN")
C4=$(echo "$D4" | jq -r '.guest.qr.code // "none"')
echo "credential after cancel: $(echo "$D4" | jq -r .guest.credential.status)"
curl -s -X POST $BASE/checkin/scan -H "Authorization: Bearer $SCANNER_TOKEN" -H 'Content-Type: application/json' -d "{\"eventId\":\"$EVENT_ID\",\"code\":\"$(curl -s $BASE/guests/$G4 -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.guest.qr.code // ""')\"}" | jq '{result}' 2>/dev/null || echo "(no active QR — as expected)"

step "18. Reports"
curl -s "$BASE/reports/guests.csv?eventId=$EVENT_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | head -3
echo "…"
curl -s "$BASE/reports/attendance.csv?eventId=$EVENT_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | wc -l | xargs echo "attendance.csv lines:"

step "DONE"
