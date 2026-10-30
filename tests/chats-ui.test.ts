import { afterEach, beforeEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createChatHistory } from '../src/chats-ui';

const original={document:globalThis.document,fetch:globalThis.fetch,crypto:Object.getOwnPropertyDescriptor(globalThis,'crypto')!};
const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,1));};
let dom:JSDOM,ui:ReturnType<typeof createChatHistory>,client:any;
let characters:{id:string,name:string}[],grants:string[];
beforeEach(()=>{
  dom=new JSDOM('<body></body>',{url:'http://192.168.1.2:11113'});globalThis.document=dom.window.document;
  characters=[{id:'first',name:'First'}];grants=['chats','cors_proxy'];
  globalThis.fetch=(async()=>Response.json({data:characters,total:201})) as typeof fetch;
  client={cancel(){},request:async()=>({}),requestLink:async()=>({})};
  ui=createChatHistory({permissions:{getGranted:async()=>grants,request:async()=>{throw new Error('Permission request denied by user');}}} as any,{client,getBaseUrl:()=> 'http://localhost:4577',getCaptures:()=>[],getImportedCharacter:()=>undefined,openArchive(){},onBusy(){}});
  document.body.append(ui.root);ui.activate({source:'file'});
});
afterEach(()=>{ui.destroy();dom.window.close();globalThis.document=original.document;globalThis.fetch=original.fetch;Object.defineProperty(globalThis,'crypto',original.crypto);});
const button=(text:string)=>[...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;
test('selected destination survives paging and search without being replaced by a suggestion',async()=>{
  await settle();const target=ui.root.querySelector<HTMLSelectElement>('#jar-chat-target')!;
  target.value='first';target.dispatchEvent(new dom.window.Event('change'));
  characters=[{id:'second',name:'Second'}];button('Next').click();await settle();
  expect(target.value).toBe('first');expect([...target.options].filter(option=>option.value==='first')).toHaveLength(1);
  button('Find').click();await settle();expect(target.value).toBe('first');
});
test('history file preview works without secure-context crypto',async()=>{
  await settle();Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:crypto.getRandomValues.bind(crypto)}});
  const input=ui.root.querySelector<HTMLInputElement>('input[type=file]')!;
  const text=JSON.stringify({user_name:'You',character_name:'Character',create_date:'2024-01-01'})+'\n'+JSON.stringify({name:'You',is_user:true,mes:'Hello',send_date:'2024-01-01'});
  Object.defineProperty(input,'files',{configurable:true,value:[new File([text],'history.jsonl',{lastModified:1})]});input.dispatchEvent(new dom.window.Event('change'));
  await settle();expect(ui.root.querySelector<HTMLElement>('.jar-chat-review')!.hidden).toBe(false);expect(ui.root.textContent).toContain('Review the messages');
});
test('denying local JAR permission returns to an actionable state',async()=>{
  await settle();grants=[];button('From JAR').click();
  const input=ui.root.querySelector<HTMLInputElement>('#jar-chat-link')!;input.value='https://janitorai.com/chats/123';input.dispatchEvent(new dom.window.Event('input'));
  button('Load chat').click();await settle();expect(ui.root.textContent).toContain('Allow local JAR access');expect(ui.root.getAttribute('aria-busy')).toBe('false');
});
test('after a chat comes over from JAR, the importer tells the user to switch JAR to a throwaway account',async()=>{
  ui.destroy();
  globalThis.fetch=(async(url:string)=>String(url).startsWith('/api/v1/characters/summary')?Response.json({data:characters,total:1})
    :Response.json({results:[{chat_name:'History',success:true,chat_id:'native-chat',message_count:1}],summary:{total:1,imported:1,failed:0}},{status:201})) as typeof fetch;
  ui=createChatHistory({permissions:{getGranted:async()=>grants,request:async()=>{throw new Error('denied');}}} as any,{client,getBaseUrl:()=> 'http://localhost:4577',getCaptures:()=>[],getImportedCharacter:()=>undefined,openArchive(){},onBusy(){}});
  document.body.append(ui.root);
  const jsonl=JSON.stringify({user_name:'You',character_name:'First',create_date:'2024-01-01'})+'\n'+JSON.stringify({name:'You',is_user:true,mes:'Hello',send_date:'2024-01-01'});
  ui.activate({source:'jar',recordId:'record-1',character:{id:'first',name:'First'},preparedHistory:{recordId:'record-1',chatId:'31415',characterName:'First',userName:'You',messageCount:1,jsonl}});
  await settle();
  const reminder=ui.root.querySelector<HTMLElement>('.jar-account-reminder')!;
  expect(reminder.hidden).toBe(true);
  button('Import chat').click();await settle();
  expect(reminder.hidden).toBe(false);expect(reminder.textContent).toContain('Switch JAR to a throwaway account now');expect(reminder.textContent).toContain('flagged or banned');
});
