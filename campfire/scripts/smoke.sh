#!/usr/bin/env bash
# Smoke test against a running `npm run dev` (http://localhost:8787 by default; set B= to point elsewhere).
# Needs .dev.vars with CAMPFIRE_HOST_KEY=local-host-key. Prints one line per check: label, status, body, CORS headers.
# Run it on a fresh dev server: it posts shouts, and the rate limiter remembers IPs for an hour.
set -u
B=${B:-http://localhost:8787}
O='Origin: http://localhost:4200'
J='Content-Type: application/json'
K="Authorization: Bearer ${HOST_KEY:-local-host-key}"
run() { # label, curl args...
  local label=$1; shift
  local out; out=$(curl -s -i "$@" | tr -d '\r')
  local status; status=$(echo "$out" | head -1 | cut -d' ' -f2)
  local hdrs; hdrs=$(echo "$out" | grep -i -E '^(access-control-[a-z-]+|retry-after):' | tr '\n' ' ')
  local body; body=$(echo "$out" | sed -n '/^$/,$p' | tail -n +2 | head -c 300)
  printf '%-44s %s  %s %s\n' "$label" "$status" "$body" "$hdrs"
}
run 'GET /'                          "$B/"
run 'GET /visit'                     "$B/visit" -H "$O"
run 'POST /visit'                    -X POST "$B/visit" -H "$O"
run 'POST /visit (again)'            -X POST "$B/visit" -H "$O"
run 'GET /visit (no increment)'      "$B/visit" -H "$O"
run 'OPTIONS /shouts (allowed origin)' -X OPTIONS "$B/shouts" -H "$O" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,authorization'
run 'OPTIONS /shouts (evil origin)'  -X OPTIONS "$B/shouts" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'
run 'GET /visit (evil origin)'       "$B/visit" -H 'Origin: https://evil.example'
run 'GET /shouts?client=A'           "$B/shouts?client=aaaaaaaa-1111" -H "$O"
run 'GET /shouts?client=B'           "$B/shouts?client=bbbbbbbb-2222" -H "$O"
run 'GET /shouts?client=A (again)'   "$B/shouts?client=aaaaaaaa-1111" -H "$O"
run 'GET /shouts?client=bad id'      "$B/shouts?client=no" -H "$O"
run 'POST /shouts honeypot'          -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.9' -d '{"nick":"bot","text":"buy stuff","website":"http://spam.example"}'
run 'POST /shouts ok (IP 1)'         -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.1' -d '{"nick":"  guest_4821 ","text":"  hello\n\n  fire  ","website":""}'
run 'POST /shouts again <10s (IP 1)' -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.1' -d '{"nick":"guest_4821","text":"me again","website":""}'
run 'POST /shouts other IP'          -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.2' -d '{"nick":"night.owl","text":"see https://example.com","website":""}'
run 'POST /shouts bad nick'          -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.3' -d '{"nick":"<b>hi</b>","text":"x"}'
run 'POST /shouts nick "M0rgan"'     -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.3' -d '{"nick":"M0rgan","text":"x"}'
run 'POST /shouts empty text'        -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.3' -d '{"nick":"a","text":"   "}'
run 'POST /shouts 201 chars'         -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.3' -d "{\"nick\":\"a\",\"text\":\"$(printf 'x%.0s' $(seq 201))\"}"
run 'POST /shouts blocklist'         -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.3' -d '{"nick":"a","text":"f4gg0t"}'
run 'POST /shouts two URLs'          -X POST "$B/shouts" -H "$O" -H "$J" -H 'CF-Connecting-IP: 198.51.100.3' -d '{"nick":"a","text":"http://a.example http://b.example"}'
run 'POST /shouts not JSON'          -X POST "$B/shouts" -H "$O" -H 'Content-Type: text/plain' -d 'hi'
run 'POST /shouts malformed JSON'    -X POST "$B/shouts" -H "$O" -H "$J" -d '{nope'
run 'POST /shouts 3 KB body'         -X POST "$B/shouts" -H "$O" -H "$J" -d "{\"nick\":\"a\",\"text\":\"$(head -c 3000 /dev/zero | tr '\0' x)\"}"
run 'POST /shouts wrong host key'    -X POST "$B/shouts" -H "$O" -H "$J" -H 'Authorization: Bearer nope' -d '{"text":"hi"}'
run 'POST /shouts as host'           -X POST "$B/shouts" -H "$O" -H "$J" -H "$K" -d '{"nick":"whatever","text":"welcome to the fire"}'
run 'POST /shouts as host (again, no limit)' -X POST "$B/shouts" -H "$O" -H "$J" -H "$K" -d '{"text":"delete me"}'
ID=$(curl -s "$B/shouts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.shouts.find(x=>x.text==="delete me").id)})')
run "DELETE /shouts/$ID no key"      -X DELETE "$B/shouts/$ID" -H "$O"
run "DELETE /shouts/$ID wrong key"   -X DELETE "$B/shouts/$ID" -H "$O" -H 'Authorization: Bearer nope'
run "DELETE /shouts/$ID host"        -X DELETE "$B/shouts/$ID" -H "$O" -H "$K"
run "DELETE /shouts/$ID host (again)" -X DELETE "$B/shouts/$ID" -H "$O" -H "$K"
run 'DELETE /shouts/abc host'        -X DELETE "$B/shouts/abc" -H "$O" -H "$K"
run 'GET /shouts?client=C (final)'   "$B/shouts?client=cccccccc-3333" -H "$O"
run 'PUT /visit'                     -X PUT "$B/visit" -H "$O"
run 'GET /nope'                      "$B/nope" -H "$O"
