import { test, expect } from '@playwright/test';
for (const viewport of [{width:1920,height:1080},{width:1366,height:768},{width:390,height:844}]) {
 test(`home wheel scrolling and editor round trips ${viewport.width}`,async({page})=>{
  await page.setViewportSize(viewport);
  await page.emulateMedia({reducedMotion:'reduce'});
  async function wheelToFooter(){
   await expect(page.locator('.fy-home')).toBeVisible();
   await page.mouse.move(viewport.width/2,viewport.height/2);
   // Real wheel input is essential: anchors and scrollIntoView can bypass overflow:hidden.
   await page.mouse.wheel(0,20000);
   await expect.poll(()=>page.evaluate(()=>window.scrollY),{timeout:5000}).toBeGreaterThan(500);
   await expect(page.locator('.home-footer')).toBeInViewport();
   await expect.poll(()=>page.evaluate(()=>Math.abs(document.documentElement.scrollHeight-window.innerHeight-window.scrollY))).toBeLessThan(3);
  }
  await page.goto('/');await wheelToFooter();
  for(const route of ['studio','editor']){
   await page.getByRole('link',{name:route==='studio'?'创作工作区':'原版编辑器',exact:true}).click();
   await expect(page).toHaveURL(new RegExp(`/${route}$`));
   await expect(page.locator(route==='studio'?'.studio':'.editor-shell')).toBeVisible();
   await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).overflowY)).toBe('hidden');
   expect((await page.locator('body').getAttribute('class'))??'').not.toContain('home-page');
   if(viewport.width>=1100){
    const box=await page.locator(route==='studio'?'.studio':'.editor-shell').boundingBox();
    expect(box!.height).toBe(viewport.height);
   }
   await page.getByRole('link',{name:'返回首页',exact:route==='studio'}).click();
   await wheelToFooter();
  }
  await page.screenshot({path:`docs/home/scroll-fix/footer-${viewport.width}.png`});
 });
}
