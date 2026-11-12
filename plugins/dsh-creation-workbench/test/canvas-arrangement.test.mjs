import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeCardBlocks } from '../src/canvas-arrangement.mjs';

test('arrangement keeps reading order, accommodates uneven sizes and leaves fixed boxes clear', () => {
  const blocks = [
    { id: 'group', x: 20, y: 30, width: 540, height: 260 },
    { id: 'last', x: 100, y: 130, width: 340, height: 160 },
    { id: 'first-row', x: 50, y: 30, width: 258, height: 208 },
    { id: 'second-row', x: 12, y: 130, width: 200, height: 180 },
  ];
  const fixed = [{ x: 530, y: 45, width: 240, height: 160 }];
  const positions = arrangeCardBlocks(blocks, fixed);
  assert.deepEqual([...positions], [
    ['group', { x: 818, y: 30 }], ['first-row', { x: 1406, y: 30 }],
    ['second-row', { x: 12, y: 338 }], ['last', { x: 260, y: 338 }],
  ]);
  assert.deepEqual(arrangeCardBlocks(blocks.map(block => ({ ...block, ...positions.get(block.id) })), fixed), positions);
});

test('arrangement shifts inward near the coordinate limit and rejects a group wider than the canvas', () => {
  const block = { id: 'one', x: 999_900, y: 999_900, width: 200, height: 160 };
  const positions = arrangeCardBlocks([block, { ...block, id: 'two' }], []);
  assert.deepEqual([...positions.values()], [{ x: 999_552, y: 999_840 }, { x: 999_800, y: 999_840 }]);
  assert.throws(() => arrangeCardBlocks([{ ...block, width: 2_000_001 }], []), /坐标范围/);
});

function clear(blocks, fixed, positions) {
  const placed=blocks.map(block=>({...block,...positions.get(block.id)}));
  for(let n=0;n<placed.length;n++)for(const other of [...placed.slice(n+1),...fixed]) {
    const node=placed[n];
    assert(!(node.x<other.x+other.width && node.x+node.width>other.x && node.y<other.y+other.height && node.y+node.height>other.y),node.id+' overlaps '+other.id);
  }
}
const block=(id,x=0,y=0,width=320,height=256)=>({id,x,y,width,height});
const source=(from,to)=>({source:from,target:to,provenance:true});

test('source chain and fan-in levels override scattered old coordinates and manual back-links',()=>{
 const blocks=[block('A',900,800),block('B',0,0,620,180),block('C',100,800,210,500),block('D',440,50,1200,400),block('note',200,300)];
 const edges=[source('A','B'),source('A','C'),source('B','D'),source('C','D'),{source:'D',target:'A'},{source:'B',target:'note'}];
 const positions=arrangeCardBlocks(blocks,[],edges);
 assert(positions.get('A').x<positions.get('B').x);
 assert.equal(positions.get('B').x,positions.get('C').x);
 assert.equal(positions.get('note').x,positions.get('B').x);
 assert(positions.get('B').x<positions.get('D').x);
 const branchTop=Math.min(positions.get('B').y,positions.get('C').y);
 const branchBottom=Math.max(positions.get('B').y+180,positions.get('C').y+500);
 assert.equal(positions.get('A').y+128,(branchTop+branchBottom)/2);
 clear(blocks,[],positions);
 assert.deepEqual(arrangeCardBlocks(blocks.map(b=>({...b,...positions.get(b.id)})),[],edges),positions);
});

test('related families remain separated, source cycles share a column and fixed boxes remain clear',()=>{
 const blocks=['A','B','C','D','E','island1','island2'].map((id,i)=>block(id,i*15,i*20));
 const fixed=[block('whiteboard',400,0,500,900)];
 const edges=[source('A','B'),source('B','C'),source('C','B'),{source:'D',target:'E'}];
 const positions=arrangeCardBlocks(blocks,fixed,edges);
 assert.equal(positions.get('B').x,positions.get('C').x);
 assert(positions.get('A').x<positions.get('B').x);
 assert(positions.get('D').x<positions.get('E').x);
 assert(positions.get('D').y>Math.max(...['A','B','C'].map(id=>positions.get(id).y+256)));
 clear(blocks,fixed,positions);
 assert.deepEqual(arrangeCardBlocks(blocks.map(b=>({...b,...positions.get(b.id)})),fixed,edges),positions);
});

test('group blocks move atomically and a 300-card graph retains layers without overlaps',()=>{
 const blocks=Array.from({length:300},(_,i)=>block('n'+i,(i%5)*10,Math.floor(i/5)*4,220+i%7*10,160+i%5*20));
 const edges=blocks.slice(20).map((node,i)=>source('n'+i,node.id));
 const positions=arrangeCardBlocks(blocks,[],edges);
 assert.equal(positions.size,300);
 for(const edge of edges)assert(positions.get(edge.source).x<positions.get(edge.target).x);
 clear(blocks,[],positions);
 assert.deepEqual(arrangeCardBlocks(blocks.map(b=>({...b,...positions.get(b.id)})),[],edges),positions);
 const groups=[block('upstream-group',700,700,650,700),block('downstream',0,0)];
 const groupPositions=arrangeCardBlocks(groups,[],[source('upstream-group','downstream')]);
 assert(groupPositions.get('upstream-group').x+650<groupPositions.get('downstream').x);
});
