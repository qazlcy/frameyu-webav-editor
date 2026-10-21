export interface MediaInfo {id:string; durationMs:number; width:number; height:number}
export interface Frame {assetId:string; timeMs:number; image:string}
export interface Plan {version:1;unit:'ms';segments:{op:'cut';assetId:string;inMs:number;outMs:number;volume:number}[];titles:{op:'title';text:string;startMs:number;endMs:number;position:'top'|'center'|'bottom';source:'user'|'generated'}[];notes:string[]}
export const LIMITS: {assets:number;framesPerAsset:number;frames:number;frameChars:number;bodyBytes:number;outputChars:number;segments:number;titles:number;durationMs:number};
export function validatePlan(plan:unknown,assets:MediaInfo[]):Plan;
export function validateAssets(assets:unknown):MediaInfo[];
export function validateRequest(r:unknown):any;
export function validateAnalysis(a:unknown,frames:Frame[]):{frames:{assetId:string;timeMs:number;description:string}[]};
export function mockPlan(r:any):Plan;
