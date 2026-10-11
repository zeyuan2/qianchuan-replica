// Pure render-decision helper. The LAN page polls every 15 seconds while a
// full snapshot only changes every 5 minutes, so an unchanged poll must not
// rebuild the table. The key covers every input that changes visible rows or
// metric cards; any user-driven query change produces a different key.
export function tableRenderKey(model,query,selectedTop=[],selectedTable=[]){
 return JSON.stringify([
  model?.fetchedAt??'',model?.page??1,model?.pageSize??10,model?.total??0,model?.plans?.length??0,model?.newEventCount??0,
  query?.search??'',query?.product??'selected',query?.status??'all',query?.service??'all',query?.serviceMode??'include',query?.costStatus??'all',query?.sortField??'',query?.sortType??'',query?.onlyNew===true,
  [...selectedTop],[...selectedTable]
 ]);
}
