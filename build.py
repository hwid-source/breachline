import sys,io,json,struct;sys.path.insert(0,'.')
from glb import *;import numpy as np
from PIL import Image
from scipy.optimize import minimize
exec(open('prep.py').read().split("def decimate")[0])   # P2,N2,UV,I (game frame, facing -Z, 1.75 m)

# ---------- 1. bake texture color into vertices (linear), cluster-decimate ----------
img=np.array(Image.open(io.BytesIO(image(j,b,0))).convert('RGB'));h,w=img.shape[:2]
px=np.clip((UV[:,0]*(w-1)).round().astype(int),0,w-1);py=np.clip((UV[:,1]*(h-1)).round().astype(int),0,h-1)
col=(img[py,px]/255.0)**2.2
CELL=.022
key=np.floor(P2/CELL).astype(np.int64);_,inv,cnt=np.unique(key,axis=0,return_inverse=True,return_counts=True);inv=inv.ravel();n=len(cnt)
def avg(a):
    o=np.zeros((n,a.shape[1]));np.add.at(o,inv,a);return o/cnt[:,None]
V=avg(P2);Nn=avg(N2);Nn/=np.maximum(np.linalg.norm(Nn,axis=1,keepdims=True),1e-9);C=avg(col)
T=inv[I];ok=(T[:,0]!=T[:,1])&(T[:,1]!=T[:,2])&(T[:,0]!=T[:,2]);T=T[ok]
_,idx=np.unique(np.sort(T,axis=1),axis=0,return_index=True);T=T[np.sort(idx)]
used=np.unique(T);rm=-np.ones(n,np.int64);rm[used]=np.arange(len(used));V,Nn,C=V[used],Nn[used],C[used];T=rm[T]
print('verts',len(V),'tris',len(T))

# ---------- 2. skeleton (rest positions in game space; character faces -Z, right = +X) ----------
J=[('Hips',None,(0,.88,0)),('Spine',0,(0,1.10,0)),('Head',1,(0,1.46,0)),('Weapon',1,(.06,1.20,-.50)),
   ('LeftUpLeg',0,(-.14,.86,0)),('LeftLeg',4,(-.24,.52,0)),('RightUpLeg',0,(.14,.86,0)),('RightLeg',6,(.24,.52,0)),
   ('LeftArm',1,(-.22,1.38,0)),('LeftForeArm',8,(-.40,1.08,0)),('RightArm',1,(.22,1.38,0)),('RightForeArm',10,(.40,1.08,0))]
pos=np.array([p for _,_,p in J],float);par=[p for _,p,_ in J];nm=[x[0] for x in J]
ANK={'L':np.array([-.30,.12,0]),'R':np.array([.30,.12,0])};WR={'L':np.array([-.46,.80,0]),'R':np.array([.46,.80,0])}
segs={ 'Hips':((0,.84,0),(0,1.0,0)),'Spine':((0,1.0,0),(0,1.40,0)),'Head':((0,1.46,0),(0,1.68,0)),
 'LeftUpLeg':((-.14,.86,0),(-.24,.52,0)),'LeftLeg':((-.24,.52,0),(-.31,.04,-.04)),'RightUpLeg':((.14,.86,0),(.24,.52,0)),'RightLeg':((.24,.52,0),(.31,.04,-.04)),
 'LeftArm':((-.22,1.38,0),(-.40,1.08,0)),'LeftForeArm':((-.40,1.08,0),(-.47,.74,0)),'RightArm':((.22,1.38,0),(.40,1.08,0)),'RightForeArm':((.40,1.08,0),(.47,.74,0))}
def segd(Pt,a,b_):
    a=np.array(a);b_=np.array(b_);ab=b_-a;t=np.clip(((Pt-a)@ab)/(ab@ab),0,1);return np.linalg.norm(Pt-(a+t[:,None]*ab),axis=1)
ss=lambda e0,e1,x:np.clip((x-e0)/(e1-e0),0,1)**2*(3-2*np.clip((x-e0)/(e1-e0),0,1))
skin=[b_ for b_ in nm if b_!='Weapon'];W_=np.zeros((len(V),len(nm)))
for b_ in skin:
    d=segd(V,*segs[b_]);wgt=1.0/(d+.03)**4;x=V[:,0];y=V[:,1]
    if 'Left' in b_: wgt*=ss(.05,-.02,x)*0+ (1-ss(-.06,.03,x))
    if 'Right' in b_: wgt*=ss(-.03,.06,x)
    if 'Arm' in b_: wgt*=ss(.10,.20,np.abs(x))
    if 'Leg' in b_: wgt*=ss(1.05,.85,y)
    if b_=='Head': wgt*=ss(1.38,1.46,y)
    W_[:,nm.index(b_)]=wgt
W_/=np.maximum(W_.sum(1,keepdims=True),1e-12)
top=np.argsort(-W_,axis=1)[:,:4];tw=np.take_along_axis(W_,top,1);tw/=np.maximum(tw.sum(1,keepdims=True),1e-9)

# ---------- 3. rotations / FK / arm pose solving ----------
def Rx(a):c,s=np.cos(a),np.sin(a);return np.array([[1,0,0],[0,c,-s],[0,s,c]])
def Ry(a):c,s=np.cos(a),np.sin(a);return np.array([[c,0,s],[0,1,0],[-s,0,c]])
def Rz(a):c,s=np.cos(a),np.sin(a);return np.array([[c,-s,0],[s,c,0],[0,0,1]])
def q_of(R):
    t=np.trace(R)
    if t>0:s=np.sqrt(t+1)*2;q=[(R[2,1]-R[1,2])/s,(R[0,2]-R[2,0])/s,(R[1,0]-R[0,1])/s,s/4]
    elif R[0,0]>R[1,1] and R[0,0]>R[2,2]:s=np.sqrt(1+R[0,0]-R[1,1]-R[2,2])*2;q=[s/4,(R[0,1]+R[1,0])/s,(R[0,2]+R[2,0])/s,(R[2,1]-R[1,2])/s]
    elif R[1,1]>R[2,2]:s=np.sqrt(1+R[1,1]-R[0,0]-R[2,2])*2;q=[(R[0,1]+R[1,0])/s,s/4,(R[1,2]+R[2,1])/s,(R[0,2]-R[2,0])/s]
    else:s=np.sqrt(1+R[2,2]-R[0,0]-R[1,1])*2;q=[(R[0,2]+R[2,0])/s,(R[1,2]+R[2,1])/s,s/4,(R[1,0]-R[0,1])/s]
    q=np.array(q);return q/np.linalg.norm(q)
def arm_fk(side,prm,spine_off=np.zeros(3)):
    S=pos[nm.index(side+'Arm')];E=pos[nm.index(side+'ForeArm')];Wr=WR[side[0]]
    chi,th,phi,al=prm;Rs=Ry(chi)@Rx(th)@Rz(phi);Re=Rs@Rx(al);el=S+Rs@(E-S);wr=el+Re@(Wr-E);tip=wr+Re@(Wr-E)/np.linalg.norm(Wr-E)*.08
    return tip
def solve(side,target,x0):
    f=lambda p:np.sum((arm_fk(side,p)-target)**2)*100+.004*np.sum((np.array(p)-np.array([0,.5,0,.8]))**2)
    r=minimize(f,x0,method='L-BFGS-B',bounds=[(-1.0,1.0),(0,1.5),(-.9,.9),(0,2.0)]);return r.x
WB={'rest':np.array([.06,1.20,-.50]),'aim':np.array([.06,1.40,-.50])}
def targets(wb):return {'Right':wb+np.array([0,-.08,.12]),'Left':wb+np.array([0,-.04,-.15])}  # rear grip / fore grip
ARM={}
for pose,wb in WB.items():
    tg=targets(wb)
    for side in ('Right','Left'):
        sg=1 if side=='Right' else -1
        best=min((solve(side,tg[side],np.array([c,th,ph*sg,al])) for c in (0,.4,-.4) for th in (.5,1.2) for ph in (-.4,.4) for al in (.4,1.2)),key=lambda p:np.sum((arm_fk(side,p)-tg[side])**2))
        ARM[(pose,side)]=best;print(pose,side,best.round(2),'err',np.linalg.norm(arm_fk(side,best)-tg[side]).round(3))
np.save('arm.npy',{str(k):v for k,v in ARM.items()},allow_pickle=True)

# ---------- 4. animation clips ----------
def arm_rot(pose,side,mix=0.0):
    chi,th,phi,al=ARM[(pose,side)];return Ry(chi)@Rx(th)@Rz(phi),Rx(al)
I3=np.eye(3)
def clip(name,T_,N,f):
    ts=np.linspace(0,T_,N+1);ch={}
    for i,t in enumerate(ts):
        ph=2*np.pi*t/T_ if i<N else 2*np.pi
        for bone,(rot,tr) in f(ph).items():
            d=ch.setdefault(bone,{'t':[], 'r':[]});d['r'].append(q_of(rot) if rot is not None else None)
            if tr is not None:d.setdefault('p',[]).append(tr)
    return name,ts,ch
def base(pose='rest'):
    out={}
    for s in ('Right','Left'):
        ru,rf=arm_rot(pose,s);out[s+'Arm']=(ru,None);out[s+'ForeArm']=(rf,None)
    out['Weapon']=(I3,WB[pose]-pos[1]);return out
def idle(ph):
    o=base();k=np.sin(ph);o['Hips']=(I3,pos[0]+np.array([0,.004*k,0]));o['Spine']=(Rx(.012*k),None);o['Head']=(Rx(-.01*k),None);o['LeftUpLeg']=(I3,None);o['RightUpLeg']=(I3,None);o['LeftLeg']=(I3,None);o['RightLeg']=(I3,None);return o
def gait(A,B,bob,lean):
    def f(ph):
        o=base();s=np.sin(ph);o['Hips']=(Rx(0),pos[0]+np.array([0,bob*abs(np.sin(ph)) ,0]))
        o['Spine']=(Rx(lean)@Ry(.04*s),None);o['Head']=(Rx(-lean*.7),None)
        for side,off in (('Left',0),('Right',np.pi)):
            a=ph+off;o[side+'UpLeg']=(Rx(A*np.sin(a)),None);o[side+'Leg']=(Rx(-B*(.5+.5*np.cos(a+.5))),None)
        return o
    return f
def shoot(ph):
    o=base('aim');k=max(0,np.cos(ph));o['Spine']=(Rx(-.04*k),None);o['Hips']=(I3,pos[0]);o['Head']=(Rx(.02*k),None)
    o['Weapon']=(Rx(.03*k),WB['aim']-pos[1]+np.array([0,0,.03*k]))
    for side in ('Left','Right'):o[side+'UpLeg']=(I3,None);o[side+'Leg']=(I3,None)
    return o
CLIPS=[clip('Idle',2.4,24,idle),clip('Walk',1.0,20,gait(.55,.9,.02,.03)),clip('Run',.62,20,gait(.95,1.5,.045,.16)),clip('Shoot',.2,10,shoot)]

# ---------- 5. write GLB ----------
bin_=bytearray();bvs=[];accs=[]
def add(arr,ctype,typ,target=None,minmax=False,norm=False):
    global bin_
    while len(bin_)%4:bin_+=b'\0'
    data=arr.tobytes();bvs.append({'buffer':0,'byteOffset':len(bin_),'byteLength':len(data),**({'target':target} if target else {})});bin_+=data
    a={'bufferView':len(bvs)-1,'componentType':ctype,'count':len(arr),'type':typ}
    if minmax:a['min']=arr.min(0).tolist();a['max']=arr.max(0).tolist()
    if norm:a['normalized']=True
    accs.append(a);return len(accs)-1
pA=add(V.astype(np.float32),5126,'VEC3',34962,True);nA=add(Nn.astype(np.float32),5126,'VEC3',34962)
cA=add(np.clip(np.concatenate([C,np.ones((len(C),1))],1)*255,0,255).round().astype(np.uint8),5121,'VEC4',34962,norm=True)
jA=add(np.concatenate([top,np.zeros((len(top),0))],1).astype(np.uint8),5121,'VEC4',34962);wA=add(tw.astype(np.float32),5126,'VEC4',34962)
iA=add(T.astype(np.uint16).reshape(-1),5123,'SCALAR',34963)
ibm=np.zeros((len(J),16),np.float32)
for k in range(len(J)):m=np.eye(4);m[:3,3]=-pos[k];ibm[k]=m.T.reshape(-1)  # column-major
ibA=add(ibm.reshape(-1,16)[:, :].reshape(len(J),16),5126,'MAT4')
accs[ibA]['count']=len(J)
nodes=[]
for k,(name,p,ps) in enumerate(J):
    nd={'name':name,'translation':(pos[k]-(pos[p] if p is not None else 0)).tolist()};ch=[i for i,(_,pp,_) in enumerate(J) if pp==k]
    if ch:nd['children']=ch
    nodes.append(nd)
nodes.append({'name':'Soldier','mesh':0,'skin':0})
anims=[]
for name,ts,ch in CLIPS:
    tA=add(ts.astype(np.float32),5126,'SCALAR',None,True);samplers=[];channels=[]
    for bone,d in ch.items():
        k=nm.index(bone);
        if any(q is not None for q in d['r']):
            qs=np.array([q if q is not None else q_of(I3) for q in d['r']],np.float32)
            for i in range(1,len(qs)):
                if qs[i]@qs[i-1]<0:qs[i]=-qs[i]
            samplers.append({'input':tA,'output':add(qs,5126,'VEC4'),'interpolation':'LINEAR'});channels.append({'sampler':len(samplers)-1,'target':{'node':k,'path':'rotation'}})
        if 'p' in d:
            ps=np.array([ (p_ if p_ is not None else nodes[k]['translation']) for p_ in d['p']],np.float32)
            if len(ps)==len(ts):
                samplers.append({'input':tA,'output':add(ps,5126,'VEC3'),'interpolation':'LINEAR'});channels.append({'sampler':len(samplers)-1,'target':{'node':k,'path':'translation'}})
    anims.append({'name':name,'samplers':samplers,'channels':channels})
# translations for Hips/Weapon are world-ish: convert Weapon (relative to Spine already) ok; Hips absolute == local (root)
G={'asset':{'version':'2.0','generator':'breachline-rig'},'scene':0,'scenes':[{'nodes':[0,len(J)]}],'nodes':nodes,
 'meshes':[{'primitives':[{'attributes':{'POSITION':pA,'NORMAL':nA,'COLOR_0':cA,'JOINTS_0':jA,'WEIGHTS_0':wA},'indices':iA,'material':0}]}],
 'materials':[{'name':'soldier','pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':.15,'roughnessFactor':.75}}],
 'skins':[{'joints':list(range(len(J))),'inverseBindMatrices':ibA,'skeleton':0}],'animations':anims,
 'buffers':[{'byteLength':len(bin_)}],'bufferViews':bvs,'accessors':accs}
js=json.dumps(G,separators=(',',':')).encode();js+=b' '*((4-len(js)%4)%4);bb=bytes(bin_)+b'\0'*((4-len(bin_)%4)%4)
out=struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(bb))+struct.pack('<II',len(js),0x4E4F534A)+js+struct.pack('<II',len(bb),0x004E4942)+bb
import os;os.makedirs('out',exist_ok=True);open('out/soldier.glb','wb').write(out);print('GLB bytes',len(out))
np.savez('rig.npz',V=V,W=W_,pos=pos)
