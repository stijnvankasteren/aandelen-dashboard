#!/bin/bash
# Gebruik: ./reset_password.sh <gebruikersnaam> <nieuw wachtwoord>

if [ "$#" -ne 2 ]; then
  echo "Gebruik: ./reset_password.sh <gebruikersnaam> <nieuw wachtwoord>"
  exit 1
fi

USERNAME="$1"
PASSWORD="$2"

docker exec portfolio-proxy python3 -c "
import sqlite3, hashlib
conn = sqlite3.connect('/app/data/users.db')
cur = conn.execute('UPDATE users SET password_hash=? WHERE username=?',
  (hashlib.sha256(b'$PASSWORD').hexdigest(), '$USERNAME'))
conn.commit()
if cur.rowcount == 0:
    print('Gebruiker niet gevonden: $USERNAME')
else:
    print('Wachtwoord gewijzigd voor: $USERNAME')
"
