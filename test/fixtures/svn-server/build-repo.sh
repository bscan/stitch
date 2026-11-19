# Builds /srv/svn/repo (and /srv/svn/other, a second repository for UUID checks)
# and records what the svn client says about them in /srv/expected/.
#
# History of the file under test (trunk/a.txt, renamed to trunk/b.txt in r9):
#   r1  mkdir trunk branches tags
#   r2  add trunk/a.txt, trunk/other.txt, trunk/kw.txt, trunk/latin1.txt, "trunk/sp ace#%.txt"
#   r3  edit a
#   r4  branch trunk -> branches/feat
#   r5  feat: edit a          r6  trunk: edit a          r7  feat: edit a
#   r8  merge feat into trunk (merged revisions: r5, r7)
#   r9  rename a.txt -> b.txt          r10 edit b
#   r11 edit other.txt only (not in b's history)
#   r12 propset svn:ignore on trunk (a prop change that is not a merge)
#   r13 branch trunk -> branches/two   r14 two: edit b
#   r15 merge two into trunk (merged revision: r14)
#   r16–r25  ten edits of b (paging)
#
# /srv/svn/other (its own UUID) holds lines.txt, whose lines move around a known
# range (lines 10–12 of r1), for history by line range:
#   r1  add lines 1–20          r2  three lines on top (range moves down)
#   r3  edit line 11 (inside)   r4  edit line 2 (outside)
#   r5  delete line 5 (outside, range moves up)
#   r6  insert a line after line 10 (inside)        r7  append a line (outside)
#
# /srv/svn/edge (its own UUID) holds unusual file histories for line searches
# (texts from file-revs-report vs a GET per revision). All files in trunk, 30 lines
# "line N" when added, unless said otherwise:
#   r1  mkdir trunk branches
#   r2  add f.txt d.txt r.txt p.txt e.txt mix.txt bin.dat "é &<>'\".txt"
#   r3  edit f, d (line 2)        r4  branch trunk -> branches/b
#   r5  trunk: edit f, d (line 5) r6  b: edit f (line 6)     r7  trunk: edit f (line 7)
#   r8  replace trunk/f.txt by a copy of branches/b/f.txt@7 (r7: not a change of b/f.txt)
#   r9  edit f (line 9)
#   r10 delete d                  r11 d back as a copy of d@3 (older than d's last change, r5)
#   r12 edit d (line 12)
#   r13 delete r                  r14 add r again (no copy)
#   r15 replace r (no copy)       r16 edit r (line 4)
#   r17 edit "é…" (line 3)        r18 property only on f.txt
#   r19 edit f (line 19), "é…" (line 19)
#   r20 new bin.dat; mix.txt becomes binary
#   r21 new bin.dat; mix.txt text again (line 8 edited)
#   r22 edit e (line 1), new bin.dat
#   r23 e emptied (0 bytes)       r24 e refilled ("again N")   r25 edit e (line 7)
#   r26–r90 edit p (line i%30+1 in r<i>), renamed p.txt -> q.txt in r55 (no edit):
#       66 revisions of q.txt, more than a 50-entry log page; line 10: r69, r39, r2.
set -eu
export LC_ALL=C TZ=UTC
mkdir -p /srv/svn /srv/expected /tmp/w
svnadmin create /srv/svn/repo
svnadmin create /srv/svn/other
R=file:///srv/svn/repo
svn mkdir -q -m 'r1: layout' $R/trunk $R/branches $R/tags --username admin
svn checkout -q $R/trunk /tmp/w/trunk
cd /tmp/w/trunk
seq 1 30 | sed 's/^/line /' > a.txt
echo other > other.txt
printf '$Id$\n$Rev$\nbody\n' > kw.txt
printf 'caf\351\n' > latin1.txt
echo 'odd name' > 'sp ace#%.txt'
svn add -q a.txt other.txt kw.txt latin1.txt 'sp ace#%.txt'
svn propset -q svn:keywords 'Id Rev' kw.txt
svn commit -q -m 'r2: add files' --username alice
sed -i 's/^line 2$/line 2 r3/' a.txt; svn commit -q -m 'r3: edit a' --username bob
svn copy -q -m 'r4: branch feat' $R/trunk $R/branches/feat --username alice
svn checkout -q $R/branches/feat /tmp/w/feat
cd /tmp/w/feat; sed -i 's/^line 10$/line 10 r5/' a.txt; svn commit -q -m 'r5: feat edit' --username carol
cd /tmp/w/trunk; sed -i 's/^line 20$/line 20 r6/' a.txt; svn commit -q -m 'r6: trunk edit' --username bob
cd /tmp/w/feat; sed -i 's/^line 12$/line 12 r7/' a.txt; svn commit -q -m 'r7: feat edit 2
with a second line' --username carol
cd /tmp/w/trunk; svn update -q; svn merge -q $R/branches/feat; svn commit -q -m 'r8: merge feat' --username alice
svn update -q; svn move -q a.txt b.txt; svn commit -q -m 'r9: rename a -> b' --username alice
sed -i 's/^line 4$/line 4 r10/' b.txt; svn commit -q -m 'r10: edit b' --username bob
echo more >> other.txt; svn commit -q -m 'r11: other only' --username bob
svn update -q; svn propset -q svn:ignore '*.o' .; svn commit -q -m 'r12: ignore' --username bob
svn copy -q -m 'r13: branch two' $R/trunk $R/branches/two --username alice
svn checkout -q $R/branches/two /tmp/w/two
cd /tmp/w/two; sed -i 's/^line 14$/line 14 r14/' b.txt; svn commit -q -m 'r14: two edit' --username dave
cd /tmp/w/trunk; svn update -q; svn merge -q $R/branches/two; svn commit -q -m 'r15: merge two' --username alice
for i in 16 17 18 19 20 21 22 23 24 25; do
  svn update -q; sed -i "s/^line $((i + 5))\$/line $((i + 5)) r$i/" b.txt; svn commit -q -m "r$i: edit b" --username bob
done

O=file:///srv/svn/other
svn checkout -q $O /tmp/w/other
cd /tmp/w/other
seq 1 20 | sed 's/^/line /' > lines.txt
svn add -q lines.txt; svn commit -q -m 'o1: add lines' --username alice
{ printf 'top 1\ntop 2\ntop 3\n'; cat lines.txt; } > t; mv t lines.txt; svn commit -q -m 'o2: three lines on top' --username bob
sed -i 's/^line 11$/line 11 o3/' lines.txt; svn commit -q -m 'o3: edit line 11' --username carol
sed -i 's/^line 2$/line 2 o4/' lines.txt; svn commit -q -m 'o4: edit line 2' --username bob
sed -i '/^line 5$/d' lines.txt; svn commit -q -m 'o5: drop line 5' --username bob
awk '{ print } $0 == "line 10" { print "inserted" }' lines.txt > t; mv t lines.txt; svn commit -q -m 'o6: insert after line 10' --username dave
echo tail >> lines.txt; svn commit -q -m 'o7: append' --username bob

E=/srv/expected
svnlook uuid /srv/svn/repo > $E/uuid.txt
svnlook uuid /srv/svn/other > $E/other-uuid.txt
svn log --xml -v $R/trunk/b.txt > $E/log-b.xml
svn log --xml -v -g -r 8 $R/trunk/b.txt > $E/log-g-8.xml
svn log --xml -v -g -r 15 $R/trunk/b.txt > $E/log-g-15.xml
svn log --xml -v -g -r 12 $R/trunk/b.txt > $E/log-g-12.xml 2>/dev/null || true
svn log --xml -v "$R/trunk/sp%20ace%23%25.txt" > $E/log-space.xml
# Folder histories: trunk itself, a branch (followed back through its copy from trunk), a merge into trunk.
svn log --xml -v $R/trunk > $E/log-trunk.xml
svn log --xml -v $R/branches/two > $E/log-two.xml
svn log --xml -v -g -r 15 $R/trunk > $E/log-g-trunk-15.xml
svn cat $O/lines.txt > $E/cat-lines.txt
# The file under test at a few revisions (its path: trunk/a.txt up to r8, trunk/b.txt from r9).
for r in 2 3 5 8; do svn cat "$R/trunk/a.txt@$r" > $E/cat-b-$r.txt; done
for r in 9 25; do svn cat "$R/trunk/b.txt@$r" > $E/cat-b-$r.txt; done
svn cat $R/trunk/kw.txt > $E/cat-kw.txt
svn cat --ignore-keywords $R/trunk/kw.txt > $E/cat-kw-raw.txt
svn cat $R/trunk/latin1.txt > $E/cat-latin1.txt
# The edge repository (see the top). UTF-8 locale for the non-ASCII file name.
(
export LC_ALL=C.UTF-8
X=file:///srv/svn/edge
SP="é &<>'\".txt"
svnadmin create /srv/svn/edge
# edl FILE LINE TAG: appends " TAG" to line LINE.
edl() { awk -v n="$2" -v t="$3" 'NR == n { $0 = $0 " " t } { print }' "$1" > /tmp/w/ed.tmp; cat /tmp/w/ed.tmp > "$1"; }
bin() { { printf '\000\001\002binary %s\n' "$1"; seq 1 200 | sed "s/^/$1 /"; } > bin.dat; }
ci() { svn commit -q -m "$1" --username "${2:-bob}"; }
svn mkdir -q -m 'e1: layout' $X/trunk $X/branches --username admin
svn checkout -q $X/trunk /tmp/w/edge
cd /tmp/w/edge
for f in f.txt d.txt r.txt p.txt e.txt mix.txt "$SP"; do seq 1 30 | sed 's/^/line /' > "$f"; done
bin r2
svn add -q f.txt d.txt r.txt p.txt e.txt mix.txt bin.dat "$SP"; ci 'e2: add' alice
edl f.txt 2 r3; edl d.txt 2 r3; ci 'e3: edit f, d'
svn copy -q -m 'e4: branch b' $X/trunk $X/branches/b --username alice
edl f.txt 5 r5; edl d.txt 5 r5; ci 'e5: edit f, d'
svn checkout -q $X/branches/b /tmp/w/edge-b
(cd /tmp/w/edge-b && edl f.txt 6 r6 && ci 'e6: b: edit f' carol)
edl f.txt 7 r7; ci 'e7: edit f'
svn update -q; svn rm -q f.txt; svn copy -q "$X/branches/b/f.txt@7" f.txt; ci 'e8: replace f by b/f.txt@7' alice
edl f.txt 9 r9; ci 'e9: edit f'
svn rm -q d.txt; ci 'e10: delete d'
svn update -q; svn copy -q "$X/trunk/d.txt@3" d.txt; ci 'e11: d back from r3' alice
edl d.txt 12 r12; ci 'e12: edit d'
svn rm -q r.txt; ci 'e13: delete r'
seq 1 30 | sed 's/^/new /' > r.txt; svn add -q r.txt; ci 'e14: add r again'
svn update -q; svn rm -q r.txt; seq 1 30 | sed 's/^/newer /' > r.txt; svn add -q r.txt; ci 'e15: replace r'
edl r.txt 4 r16; ci 'e16: edit r'
edl "$SP" 3 r17; ci 'e17: edit special'
svn propset -q color blue f.txt; ci 'e18: property only' carol
edl f.txt 19 r19; edl "$SP" 19 r19; ci 'e19: edit f, special'
bin r20; { printf '\000mix\n'; cat mix.txt; } > /tmp/w/ed.tmp; cat /tmp/w/ed.tmp > mix.txt; ci 'e20: binary'
bin r21; seq 1 30 | sed 's/^/line /' > mix.txt; edl mix.txt 8 r21; ci 'e21: text again'
edl e.txt 1 r22; bin r22; ci 'e22: edit e'
: > e.txt; ci 'e23: empty e'
seq 1 30 | sed 's/^/again /' > e.txt; ci 'e24: refill e'
edl e.txt 7 r25; ci 'e25: edit e'
F=p.txt
for i in $(seq 26 90); do
  if [ $i = 55 ]; then svn update -q; svn move -q p.txt q.txt; ci "e$i: rename p -> q" alice; F=q.txt; continue; fi
  edl $F $(( i % 30 + 1 )) r$i; ci "e$i: edit $F"
done
svn update -q
svnlook uuid /srv/svn/edge > $E/edge-uuid.txt
# What svn blame says each line's last change was, for single-line searches.
for f in f.txt d.txt r.txt e.txt q.txt; do svn blame --xml $f > $E/edge-blame-$f.xml; done
svn blame --xml "$SP" > $E/edge-blame-special.xml
)
echo ok > $E/ready
chown -R apache:apache /srv/svn
rm -rf /tmp/w
