import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function diagnosticQueries(database,bindings){
 const db=new DatabaseSync(database,{readOnly:true});
 try{
  db.exec('BEGIN');const rows={};
  const source=readFileSync(new URL('../../docs/diagnostic-queries.sql',import.meta.url),'utf8');
  for(const block of source.split('-- name: ').slice(1)){
   const newline=block.indexOf('\n'),name=block.slice(0,newline).trim(),sql=block.slice(newline+1).trim();
   const statement=db.prepare(sql);statement.setAllowUnknownNamedParameters(true);rows[name]=statement.all(bindings);
  }
  return rows;
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
