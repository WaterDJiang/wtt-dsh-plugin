import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync} from 'node:fs';

// 资源管理校验使用固定内存，不沿用素材导入的文件大小上限。
export function digestFile(filename){
 const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);if(!before.isFile())throw new Error('所选项不是普通文件');
  const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(256*1024);let count;
  while((count=readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));
  const after=fstatSync(fd),current=lstatSync(filename);
  const same=stat=>stat.isFile()&&stat.ino===before.ino&&stat.dev===before.dev&&stat.size===before.size&&stat.mtimeMs===before.mtimeMs&&stat.ctimeMs===before.ctimeMs;
  if(!same(after)||!same(current))throw new Error('文件正在变化，请稍后重新确认');
  return {hash:digest.digest('hex'),bytes:before.size,ino:before.ino,dev:before.dev,mtime:before.mtimeMs};
 }finally{closeSync(fd)}
}
