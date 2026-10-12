#!/bin/sh
set -eu

lineage=${RENEWED_LINEAGE:?Certbot did not provide the renewed certificate path}
cp "$lineage/fullchain.pem" /output/fullchain.pem.tmp
cp "$lineage/privkey.pem" /output/privkey.pem.tmp
chmod 644 /output/fullchain.pem.tmp
chmod 600 /output/privkey.pem.tmp
mv /output/fullchain.pem.tmp /output/fullchain.pem
mv /output/privkey.pem.tmp /output/privkey.pem

if [ -f /config/attendanceapp-https.yml ]; then
  touch /config/attendanceapp-https.yml
fi