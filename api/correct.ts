import sharp from 'sharp';
import {applyColorMatrix,isValidColorMatrix} from '../src/lib/colorCorrection';
import type {ColorMatrix} from '../src/types/colorCorrector';
export async function correctImage(input:Buffer,matrix:ColorMatrix){if(input.length>20000000||!isValidColorMatrix(matrix)||Object.values(matrix.offset).some(n=>!Number.isFinite(n)||Math.abs(n)>2)||matrix.matrix.flat().some(n=>Math.abs(n)>10))throw Error('Invalid image or matrix');
 const {data,info}=await sharp(input,{limitInputPixels:16000000,animated:false}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
 if(info.channels!==4)throw Error('Unsupported channels');for(let i=0;i<data.length;i+=4){const c=applyColorMatrix({r:data[i],g:data[i+1],b:data[i+2]},matrix);data[i]=c.r;data[i+1]=c.g;data[i+2]=c.b}
 return sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer();
}
