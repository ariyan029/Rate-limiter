#!/usr/bin/env bash

# Rate Limiter Bash Test Script (Linux / macOS / Git Bash)
# Sends 7 rapid requests to test Fixed Window Counter Rate Limiting

TARGET_URL="${1:-http://localhost:3000/api/data}"

echo "=========================================================="
echo " Starting Rate Limiter Test"
echo " Target Endpoint: ${TARGET_URL}"
echo " Max allowed per window: 5 requests / 60s"
echo " Sending 7 rapid requests..."
echo "=========================================================="
echo ""

for i in {1..7}; do
  echo ">>> [Request #${i}] Sending GET ${TARGET_URL}..."
  response=$(curl -s -i "${TARGET_URL}")
  
  # Extract HTTP status line
  status_line=$(echo "${response}" | grep -E '^HTTP/' | head -n 1 | tr -d '\r')
  
  # Extract rate limit headers
  limit_hdr=$(echo "${response}" | grep -i '^X-RateLimit-Limit:' | tr -d '\r')
  remaining_hdr=$(echo "${response}" | grep -i '^X-RateLimit-Remaining:' | tr -d '\r')
  reset_hdr=$(echo "${response}" | grep -i '^X-RateLimit-Reset:' | tr -d '\r')
  retry_hdr=$(echo "${response}" | grep -i '^Retry-After:' | tr -d '\r')
  
  # Extract body
  body=$(echo "${response}" | awk 'BEGIN{RS="\r?\n\r?\n"} NR==2 {print; exit}')

  echo "Status   : ${status_line}"
  [ -n "${limit_hdr}" ] && echo "${limit_hdr}"
  [ -n "${remaining_hdr}" ] && echo "${remaining_hdr}"
  [ -n "${reset_hdr}" ] && echo "${reset_hdr}"
  [ -n "${retry_hdr}" ] && echo "${retry_hdr}"
  echo "Body     : ${body}"
  
  if echo "${status_line}" | grep -q "200"; then
    echo "Result   : PASS (Request Allowed)"
  elif echo "${status_line}" | grep -q "429"; then
    echo "Result   : PASS (Rate Limit Enforced)"
  else
    echo "Result   : UNEXPECTED STATUS"
  fi
  echo "----------------------------------------------------------"
  sleep 0.2
done

echo ""
echo "=========================================================="
echo " Test completed."
echo "=========================================================="
