import type { CSSProperties } from 'react';
const paths:Record<string,string>={
 media:'M3 5h18v14H3z M3 14l5-5 5 5 3-3 5 5 M16 8h.01',
 music:'M9 18V5l11-2v13 M9 8l11-2 M5 21a4 3 0 1 0 0-6 4 3 0 0 0 0 6 M16 19a4 3 0 1 0 0-6 4 3 0 0 0 0 6',
 text:'M4 5h16 M12 5v15 M8 20h8',
 ai:'M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z M20 2v4 M18 4h4',
 search:'M17 17l5 5 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16',
 plus:'M12 5v14 M5 12h14', close:'M5 5l14 14 M19 5L5 19',
 play:'M8 5l12 7-12 7z',pause:'M8 5v14 M16 5v14',
 undo:'M8 4L3 9l5 5 M3 9h11a6 6 0 0 1 0 12', redo:'M16 4l5 5-5 5 M21 9H10a6 6 0 0 0 0 12',
 down:'M6 9l6 6 6-6',left:'M15 5l-7 7 7 7',right:'M9 5l7 7-7 7',
 export:'M12 16V3 M7 8l5-5 5 5 M4 14v7h16v-7',save:'M4 3h13l4 4v14H3V3z M7 3v7h10V3 M7 21v-7h10v7',
 scissors:'M8 9l12 12 M8 15L20 3 M5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M5 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
 volume:'M3 9v6h4l5 4V5L7 9z M16 8q6 4 0 8 M19 5q9 7 0 14',
 eye:'M2 12q10-14 20 0-10 14-20 0 M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
 panel:'M3 4h18v16H3z M8 4v16',check:'M5 12l4 4L20 5',folder:'M3 6h7l2 3h9v11H3z',
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 send:'M3 3l19 9-19 9 4-9z M7 12h15',skip:'M5 5v14 M18 5L7 12l11 7z',
 fit:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',info:'M12 11v6 M12 7v.01 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20',
};
export function Icon({name,size=18,style}:{name:string;size?:number;style?:CSSProperties}) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true"><path d={paths[name]??paths.grid}/></svg>; }
