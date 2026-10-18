def rep(p, pairs, imp=None):
    s=open(p,encoding='utf-8').read()
    for a,b in pairs:
        n=s.count(a)
        if n==0: raise SystemExit("MISSING in %s: %s" % (p,a))
        s=s.replace(a,b)
    if imp and imp not in s:
        lines=s.split('\n')
        idx=max(i for i,l in enumerate(lines) if l.startswith('import ') or l.startswith('} from '))
        lines.insert(idx+1, imp)
        s='\n'.join(lines)
    open(p,'w',encoding='utf-8',newline='').write(s)

def addns(ns, de, en, base='i18n/'):
    for lang, block in (('de',de),('en',en)):
        p=base+lang+'/'+ns+'.ts'
        import os
        if not os.path.exists(p): p+='x'
        s=open(p,encoding='utf-8').read()
        i=s.rstrip().rfind('};')
        head=s[:i]
        if head.rstrip().endswith('{'):
            head=head.rstrip()+'\n'
        s=head+block.strip('\n')+'\n};\n'
        open(p,'w',encoding='utf-8',newline='').write(s)
