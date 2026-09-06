-- Actual plugin identity block is inserted below by the fixture runner.
local passed, failed = 0, 0
local function fixture(id, name, response)
 local jobs, retries, listeners = {}, {}, {}
 local calls = 0
 local fakeGame = {PlaceId=id,Name=name}
 function fakeGame:GetPropertyChangedSignal(property)
  return {Connect=function(_,cb) listeners[property]=cb end}
 end
 function fakeGame:GetService(service)
  assert(service=='MarketplaceService')
  return {GetProductInfo=function(_,placeId)
   calls+=1
   if response==false then error('offline') end
   return {Name=response or ('Published '..placeId)}
  end}
 end
 local fakeTask={spawn=function(f)table.insert(jobs,f)end,delay=function(_,f)table.insert(retries,f)end}
 local function init(game,task)
  local studioId='abcd-unique'
SOURCE_BLOCK
  return {label=function()return studioLabel end,markSent=function()labelSent=true end,sent=function()return labelSent end}
 end
 local api=init(fakeGame,fakeTask)
 local f={api=api,jobs=jobs,retries=retries,game=fakeGame}
 function f:flush() while #jobs>0 do table.remove(jobs,1)() end end
 function f:change(property,value) fakeGame[property]=value;if listeners[property] then listeners[property]() end end
 function f:calls()return calls end
 function f:response(value)response=value end
 return f
end
local function test(name,fn)
 local ok,err=pcall(fn)
 if ok then passed+=1 else failed+=1 end
 print(ok and 'PASS' or 'FAIL',name,ok and '' or tostring(err))
end
test('published name replaces Place1 asynchronously',function()
 local f=fixture(123,'Place1');assert(f:calls()==0);f:flush();assert(f.api.label()=='Published 123 #abcd',f.api.label())
end)
test('failure gives distinguishing place id',function()
 local f=fixture(123,'Place1',false);f:flush();assert(f.api.label()=='Place 123 #abcd',f.api.label())
end)
test('unpublished named local file preserved without network',function()
 local f=fixture(0,'Local Kitchen');f:flush();assert(f.api.label()=='Local Kitchen #abcd');assert(f:calls()==0)
end)
test('unpublished generic name is explicit',function()
 local f=fixture(0,'Place1');f:flush();assert(f.api.label()=='Unsaved Place #abcd',f.api.label());assert(f:calls()==0)
end)
test('publish changes label and invalidates sent flag',function()
 local f=fixture(0,'Place1');f.api.markSent();f:change('PlaceId',456);f:flush();assert(f.api.label()=='Published 456 #abcd');assert(not f.api.sent())
end)
test('late result cannot overwrite new place',function()
 local f=fixture(123,'Place1');f:change('PlaceId',456);f:flush();assert(f.api.label()=='Published 456 #abcd',f.api.label())
end)
test('temporary lookup failure retries',function()
 local f=fixture(123,'Place1',false);f:flush();assert(#f.retries==1,'no bounded retry');f:response('Recovered');table.remove(f.retries,1)();f:flush();assert(f.api.label()=='Recovered #abcd')
end)
test('trim name and strip control chars',function()
 local f=fixture(123,'Place1','  Kitchen\r\nTest  ');f:flush();assert(f.api.label()=='KitchenTest #abcd',f.api.label())
end)
test('local rename refreshes label',function()
 local f=fixture(0,'Local');f:change('Name','Renamed');assert(f.api.label()=='Renamed #abcd')
end)
print('LABEL_SUMMARY',passed,failed)
