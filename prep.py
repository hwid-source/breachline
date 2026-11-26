import sys;sys.path.insert(0,'.')
from glb import *;import numpy as np
j,b=load('source/TacticalSoldier.glb');p=j['meshes'][0]['primitives'][0]
P=acc(j,b,p['attributes']['POSITION']);N=acc(j,b,p['attributes']['NORMAL']);UV=acc(j,b,p['attributes']['TEXCOORD_0']);I=acc(j,b,p['indices']).reshape(-1,3).astype(np.int64)
H=1.75;s=H/(P[:,1].max()-P[:,1].min())
# orient: original faces +X, right=+Z  ->  three.js: faces -Z, right=+X
def tf(v): return np.stack([v[:,2],v[:,1],-v[:,0]],1)
P2=tf(P)*s;P2[:,1]-=P2[:,1].min();N2=tf(N)
def decimate(cell,uvcell):
    key=np.concatenate([np.floor(P2/cell),np.floor(UV/uvcell)],1).astype(np.int64)
    _,inv,cnt=np.unique(key,axis=0,return_inverse=True,return_counts=True);inv=inv.ravel();n=len(cnt)
    ap=np.zeros((n,3));an=np.zeros((n,3));au=np.zeros((n,2))
    np.add.at(ap,inv,P2);np.add.at(an,inv,N2);np.add.at(au,inv,UV)
    ap/=cnt[:,None];au/=cnt[:,None];l=np.linalg.norm(an,axis=1,keepdims=True);an=an/np.maximum(l,1e-9)
    T=inv[I];ok=(T[:,0]!=T[:,1])&(T[:,1]!=T[:,2])&(T[:,0]!=T[:,2]);T=T[ok]
    # drop duplicate tris
    T=np.unique(np.sort(T,axis=1),axis=0) if False else T
    used=np.unique(T);remap=-np.ones(n,np.int64);remap[used]=np.arange(len(used))
    return ap[used],an[used],au[used],remap[T]
for cell,uvc in [(.012,1/256),(.016,1/200),(.02,1/160)]:
    a,bn,c,T=decimate(cell,uvc);print(cell,len(a),'verts',len(T),'tris')
