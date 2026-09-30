// Shared by the catalogue and avatar applications. URLs resolve relative to
// this module, including when the site is hosted under a GitHub Pages subpath.
export const sampleModels = Object.freeze([
  {id:'default', name:'標準サンプル', file:'VRM1_Constraint_Twist_Sample.vrm', author:'pixiv Inc.',
    license:'https://vrm.dev/licenses/1.0/',
    terms:'埋め込み設定：誰でも利用可／法人の商用利用可／クレジット不要／再配布・改変再配布可'},
  ...['C','F','G','H','I','M','N','P','R','V','X','Y','Z'].map(letter=>({id:letter.toLowerCase(), name:`AvatarSample_${letter}`,
    file:`samples/AvatarSample_${letter}.vrm`, author:'pixiv VRoid Project',
    terms:'埋め込み設定：利用者は作者のみ／個人の非営利利用／クレジット必須／再配布不可／改変不可',
    license:'https://vrm.dev/licenses/1.0/'})),
].map(model=>Object.freeze({...model,url:new URL(model.file,import.meta.url).href})));

export async function sampleFile(id) {
  const model=sampleModels.find(model=>model.id===id);
  if(!model) throw new Error('サンプルが見つかりません。');
  if(id==='default') return null;
  const response=await fetch(model.url);
  if(!response.ok) throw new Error(`サンプルを取得できませんでした (${response.status})`);
  return new File([await response.blob()],model.file.split('/').at(-1),{type:'model/gltf-binary'});
}
