import json,struct,numpy as np
CT={5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}
def load(path):
    d=open(path,'rb').read();cl,_=struct.unpack('<II',d[12:20]);j=json.loads(d[20:20+cl]);o=20+cl+8
    bin_=d[o:o+struct.unpack('<I',d[20+cl:24+cl])[0]];return j,bin_
def acc(j,b,i):
    a=j['accessors'][i];bv=j['bufferViews'][a['bufferView']];dt=CT[a['componentType']];n=NC[a['type']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0);stride=bv.get('byteStride') or dt().itemsize*n
    arr=np.ndarray((a['count'],n),dtype=dt,buffer=b,offset=off,strides=(stride,dt().itemsize)).copy()
    if a.get('normalized'): 
        info=np.iinfo(dt);arr=np.maximum(arr/float(info.max),-1.0) if info.min<0 else arr/float(info.max)
    return arr.astype(np.float64) if a['componentType']!=5125 else arr
def image(j,b,i):
    bv=j['bufferViews'][j['images'][i]['bufferView']];return b[bv.get('byteOffset',0):bv.get('byteOffset',0)+bv['byteLength']]
