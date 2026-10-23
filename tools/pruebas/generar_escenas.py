"""Genera escenas SINTÉTICAS (tapete verde, banco claro, gaveta azul, pieza negra, estantería).
Sirven para comprobar la mecánica del algoritmo, NO sustituyen a fotos reales.
Uso:  python3 generar_escenas.py   (necesita numpy y pillow)
"""
import os
import numpy as np
from PIL import Image, ImageFilter
rng=np.random.default_rng(7)
N=1280
yy,xx=np.mgrid[0:N,0:N].astype(np.float32)

def pieza_mask(cx=640,cy=640,w=520,h=300,r=60):
    # rectángulo redondeado + agujero
    dx=np.abs(xx-cx)-(w/2-r); dy=np.abs(yy-cy)-(h/2-r)
    d=np.sqrt(np.maximum(dx,0)**2+np.maximum(dy,0)**2)+np.minimum(np.maximum(dx,dy),0)
    m=(d<r).astype(np.float32)
    hole=((xx-(cx-150))**2+(yy-cy)**2<45**2)
    m[hole]=0
    return m

def pieza_color(m,base=(150,150,155),cx=640,cy=640,w=520,h=300):
    g=np.clip((yy-(cy-h/2))/h,0,1)
    shade=1.25-0.7*g  # brillo vertical tipo metal
    img=np.zeros((N,N,3),np.float32)
    for c in range(3): img[...,c]=base[c]*shade
    # franja brillante
    st=((yy>cy-60)&(yy<cy-35))
    img[st]=np.minimum(img[st]+70,255)
    # tornillo
    return img

def componer(bg,m,pc,sombra=True,off=(18,26)):
    img=bg.copy()
    if sombra:
        s=np.roll(np.roll(m,off[1],0),off[0],1)
        s=np.array(Image.fromarray((s*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(14)),np.float32)/255
        img=img*(1-0.55*s[...,None])
    ms=np.array(Image.fromarray((m*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)),np.float32)/255
    img=img*(1-ms[...,None])+pc*ms[...,None]
    img+=rng.normal(0,3,img.shape)
    return np.clip(img,0,255).astype(np.uint8)

os.makedirs('escenas',exist_ok=True)
def save(name,img):
    name='escenas/'+name
    Image.fromarray(img).save(f'{name}.png')
    open(f'{name}.raw','wb').write(np.array([N,N],dtype='<u4').tobytes()+np.dstack([img,np.full((N,N),255,np.uint8)]).tobytes())

vig=1-0.25*(((xx-640)**2+(yy-640)**2)/(900**2))
# A: tapete verde oscuro
bgA=np.zeros((N,N,3),np.float32); bgA[...]=(28,62,42); bgA*=vig[...,None]
bgA+=rng.normal(0,5,bgA.shape)
m=pieza_mask(); pc=pieza_color(m)
save('A_verde',componer(bgA,m,pc))
# B: banco claro con degradado de luz
lum=1-0.18*(xx/N)-0.10*(yy/N)
bgB=np.zeros((N,N,3),np.float32); bgB[...]=(236,236,232); bgB*=lum[...,None]
pcB=pieza_color(m,base=(105,108,112))
save('B_claro',componer(bgB,m,pcB))
# C: gaveta azul: suelo azul + paredes laterales y superior más oscuras/claras
bgC=np.zeros((N,N,3),np.float32); bgC[...]=(30,90,170)
bgC[:, :90]=(18,55,110); bgC[:, -90:]=(45,120,205); bgC[:70,:]=(60,130,215)
bgC*=vig[...,None]; bgC+=rng.normal(0,4,bgC.shape)
save('C_azul',componer(bgC,m,pc))
# D: pieza negra sobre verde oscuro (difícil)
pcD=pieza_color(m,base=(40,40,42))
save('D_negra_verde',componer(bgA,m,pcD))
# E: estantería gris con listones y pieza grande tocando el borde inferior
bgE=np.zeros((N,N,3),np.float32); bgE[...]=(120,125,128)
bgE[300:330,:]=(70,72,75); bgE[900:940,:]=(175,178,180); bgE[:, 200:215]=(60,60,62)
bgE+=rng.normal(0,4,bgE.shape)
mE=pieza_mask(cy=980,w=760,h=420); pcE=pieza_color(mE,base=(205,165,60),cy=980,w=760,h=420)
save('E_estanteria',componer(bgE,mE,pcE))
print('ok')
