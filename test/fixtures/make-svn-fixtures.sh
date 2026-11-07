#!/bin/sh
# Builds SVN working-copy fixtures with real svn clients, in podman containers
# (the dev machine has no svn). Output: test/fixtures/<name>.tar.gz, holding
#   wc/        a working copy in a known state (see build() below)
#   expected/  what the real client says about it: `svn info --xml`, `svn status`,
#              `svn cat -r BASE` (keywords expanded) and with --ignore-keywords (raw)
#
# Usage: test/fixtures/make-svn-fixtures.sh            (all fixtures)
#        test/fixtures/make-svn-fixtures.sh svn114
set -eu
cd "$(dirname "$0")"
OUT=$(pwd)

# The script that runs inside the container. Dates are not fixed (svn sets them),
# so tests compare against expected/ rather than hard-coded values.
build_script() {
  cat <<'EOS'
set -eu
export LC_ALL=C TZ=UTC
mkdir -p /r /w
svnadmin create /r/repo
svn checkout -q file:///r/repo /w/wc
cd /w/wc
seq 1 30 | sed 's/^/line /' > a.txt
mkdir sub
printf 'b one\nb two\n' > sub/b.txt
printf 'old one\nold two\n' > old.txt
printf 'caf\351 cr\350me\n' > latin1.txt
printf '$Id$\n$Rev$\n$Author$\n$Date$\n$URL$\n$HeadURL$\n$LastChangedRevision$\nbody\n' > kw.txt
printf 'one\ntwo\n' > eol.txt
printf 'name with space\n' > 'with space.txt'
svn add -q a.txt sub old.txt latin1.txt kw.txt eol.txt 'with space.txt'
svn propset -q svn:keywords 'Id Rev Author Date URL HeadURL LastChangedRevision' kw.txt
svn propset -q svn:eol-style CRLF eol.txt
svn propset -q custom:prop 'x y' a.txt
svn commit -q -m 'r1: initial' --username alice
sed -i 's/^line 5$/line 5 r2/' a.txt
printf 'old one r2\nold two\n' > old.txt
svn commit -q -m 'r2: edit a, old' --username bob
svn move -q sub/b.txt sub/c.txt
svn commit -q -m 'r3: rename b -> c' --username alice
sed -i 's/^line 9$/line 9 r4/' a.txt
printf 'more\n' >> kw.txt
svn commit -q -m 'r4: edit a, kw' --username carol
svn update -q
svn update -q -r1 old.txt                     # mixed-revision: old.txt at r1

# Local, uncommitted state
sed -i 's/^line 20$/line 20 local/' a.txt     # modified
printf 'caf\351 cr\350me!\n' > latin1.txt      # modified, non-UTF-8
printf 'new\n' > new.txt; svn add -q new.txt  # added: no BASE
svn copy -q a.txt copied.txt                  # copied: BASE is the copy source
printf 'copy edit\n' >> copied.txt
printf 'unversioned\n' > unversioned.txt

mkdir -p /w/expected
svn status > /w/expected/status.txt || true
for f in a.txt sub/c.txt old.txt latin1.txt kw.txt eol.txt 'with space.txt' new.txt copied.txt; do
  name=$(echo "$f" | tr '/ ' '__')
  svn info --xml "$f" > "/w/expected/$name.info.xml"
  svn cat -r BASE "$f" > "/w/expected/$name.base" 2>/dev/null || rm -f "/w/expected/$name.base"
  svn cat -r BASE --ignore-keywords "$f" > "/w/expected/$name.base-raw" 2>/dev/null || rm -f "/w/expected/$name.base-raw"
done
svn --version --quiet > /w/expected/version.txt
cd /w && tar czf /out/fixture.tar.gz wc expected
EOS
}

make() { # name image install-command
  echo "building $1 with $2"
  build_script | podman run --rm -i -v "$OUT:/out:Z" "$2" sh -c "$3 >/dev/null && sh -s"
  mv "$OUT/fixture.tar.gz" "$OUT/$1.tar.gz"
}

want() { [ $# -eq 0 ] || echo " $* " | grep -q " $NAME "; }

APT='apt-get -o Acquire::Check-Valid-Until=false update -qq && apt-get install -y -qq --force-yes subversion'
for NAME in svn16 svn18 svn114; do
  if want "$@"; then
    case $NAME in
      svn16) make svn16 docker.io/debian/eol:squeeze "$APT" ;;    # 1.6.12
      svn18) make svn18 docker.io/debian/eol:jessie "$APT" ;;     # 1.8.10
      svn114) make svn114 docker.io/library/alpine:3.20 "apk add -q subversion" ;;
    esac
  fi
done
