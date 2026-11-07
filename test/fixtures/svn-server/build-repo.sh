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

E=/srv/expected
svnlook uuid /srv/svn/repo > $E/uuid.txt
svnlook uuid /srv/svn/other > $E/other-uuid.txt
svn log --xml -v $R/trunk/b.txt > $E/log-b.xml
svn log --xml -v -g -r 8 $R/trunk/b.txt > $E/log-g-8.xml
svn log --xml -v -g -r 15 $R/trunk/b.txt > $E/log-g-15.xml
svn log --xml -v -g -r 12 $R/trunk/b.txt > $E/log-g-12.xml 2>/dev/null || true
svn log --xml -v "$R/trunk/sp%20ace%23%25.txt" > $E/log-space.xml
# The file under test at a few revisions (its path: trunk/a.txt up to r8, trunk/b.txt from r9).
for r in 2 3 5 8; do svn cat "$R/trunk/a.txt@$r" > $E/cat-b-$r.txt; done
for r in 9 25; do svn cat "$R/trunk/b.txt@$r" > $E/cat-b-$r.txt; done
svn cat $R/trunk/kw.txt > $E/cat-kw.txt
svn cat --ignore-keywords $R/trunk/kw.txt > $E/cat-kw-raw.txt
svn cat $R/trunk/latin1.txt > $E/cat-latin1.txt
echo ok > $E/ready
chown -R apache:apache /srv/svn
rm -rf /tmp/w
