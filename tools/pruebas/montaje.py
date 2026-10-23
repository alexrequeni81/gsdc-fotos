"""Montaje original | blanquear | recortar.  Uso: python3 montaje.py salida.png A_verde B_claro ..."""
import numpy as np, sys
from PIL import Image
def leer(f):
    b=open(f,'rb').read(); w,h=np.frombuffer(b[:8],'<u4'); return Image.fromarray(np.frombuffer(b[8:],np.uint8).reshape(h,w,4)[...,:3])
names=sys.argv[2:]; rows=[]
T=300
for n in names:
    ims=[Image.open(f'escenas/{n}.png').convert('RGB'),leer(f'escenas/out_{n}_blanquear.raw'),leer(f'escenas/out_{n}_recortar.raw')]
    rows.append(np.hstack([np.array(i.resize((T,T))) for i in ims]))
Image.fromarray(np.vstack(rows)).save(sys.argv[1])
