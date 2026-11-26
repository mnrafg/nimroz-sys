#!/bin/bash
# API performance benchmark — logs in as admin and times every major endpoint
BASE=http://localhost:3000
JAR=/tmp/aogc-cookies.txt
rm -f $JAR

echo "== login =="
curl -s -c $JAR -X POST $BASE/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@aogc.gov.af","password":"Admin@123"}' -o /dev/null -w "login: %{http_code} %{time_total}s\n"

bench() {
  local name="$1"; local url="$2"
  local t=$(curl -s -b $JAR -o /dev/null -w "%{time_total}" "$BASE$url")
  echo "$name: ${t}s  ($url)"
}

echo "== endpoints (cold, first hit) =="
bench "dashboard   " "/api/dashboard?days=30"
bench "entries     " "/api/entries"
bench "importers   " "/api/importers"
bench "limits      " "/api/limits"
bench "notifications" "/api/notifications"
bench "items       " "/api/items"
bench "checkpoints " "/api/checkpoints"
bench "uoms        " "/api/uoms"
bench "reports-daily" "/api/reports?type=daily"
bench "reports-quota" "/api/reports?type=remaining_quota"
bench "reports-checkpoint" "/api/reports?type=checkpoint"
bench "reports-monthly" "/api/reports?type=monthly"
bench "reports-exception" "/api/reports?type=exception"
bench "importer-summary" "/api/importers/5/summary"
bench "global-search" "/api/importers?q=%D8%A7%D8%AD%D9%85%D8%AF"
bench "search-entries" "/api/entries?q=IMP-"

echo "== warm (second hit) =="
bench "dashboard2  " "/api/dashboard?days=30"
bench "entries2    " "/api/entries"
bench "importers2  " "/api/importers"
bench "notifications2" "/api/notifications"
bench "reports-daily2" "/api/reports?type=daily"
bench "reports-quota2" "/api/reports?type=remaining_quota"
