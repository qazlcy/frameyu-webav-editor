import { Combinator, ImgClip, OffscreenSprite } from '@webav/av-cliper';
import { sceneSvg } from './demoProject';
/** One-time, locally generated sample MP4s; also documents asset provenance. */
export async function renderDemoShot(index:number): Promise<Blob> {
  const image=new Image(); image.src=URL.createObjectURL(new Blob([sceneSvg(index)],{type:'image/svg+xml'}));
  await image.decode(); const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;canvas.getContext('2d')!.drawImage(image,0,0);URL.revokeObjectURL(image.src);
  const clip=new ImgClip(await createImageBitmap(canvas));const sprite=new OffscreenSprite(clip);await sprite.ready;
  sprite.time={offset:0,duration:4.2e6};sprite.rect.w=1280;sprite.rect.h=720;
  sprite.setAnimation({'0%':{x:0,y:0,w:1280,h:720},'100%':{x:-20,y:-12,w:1320,h:744}},{duration:4.2e6,iterCount:1});
  const compositor=new Combinator({width:1280,height:720,fps:30,bitrate:1800000,audio:false});
  try {await compositor.addSprite(sprite);return await new Response(compositor.output({maxTime:4.2e6})).blob();} finally {compositor.destroy();sprite.destroy();clip.destroy();}
}
