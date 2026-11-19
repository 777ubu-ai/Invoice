#!/usr/bin/env python3
"""Generate the user's eight-sheet workbook locally from a private template.
No external calls; transaction-specific sample values are never carried over.
"""
import copy
import datetime
import io
import json
import os
import sys
from decimal import Decimal, InvalidOperation
from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils.cell import range_boundaries, get_column_letter

NAMES=['INV','CMR','PAK','Specification','Price','заявка-заказ','Письмо о не страховании','ДЛЯ ДТ']

def dec(value):
    if value in (None,''): return None
    try:
        x=Decimal(str(value).replace(',','.'))
        return x if x.is_finite() and x>=0 else None
    except InvalidOperation: return None

def num(value):
    v=dec(value)
    return float(v) if v is not None else None

def total(items,key):
    values=[dec(x.get(key)) for x in items]
    return float(sum(values,Decimal(0))) if values and all(x is not None for x in values) else None

def display_company(c):
    c=c or {}; parts=[c.get('address',''),c.get('country',''),c.get('taxId') and 'Tax ID: '+c['taxId'],c.get('bank') and 'Bank: '+c['bank'],c.get('account') and 'Account: '+c['account'],c.get('swift') and 'SWIFT/BIC: '+c['swift'],c.get('contact') and 'Contact: '+c['contact'],c.get('extra','')]
    return '\n'.join(str(x) for x in parts if x) or None

def date(value):
    if not value:return None
    try:return datetime.date.fromisoformat(value)
    except (ValueError,TypeError):return None

def setv(ws,addr,value):
    c=ws[addr]
    if isinstance(c,MergedCell):raise ValueError('Неверная структура объединённых ячеек шаблона: '+ws.title+' '+addr)
    c.value=value
    if isinstance(value,str):c.data_type='s'

def expand(ws,start,count):
    extra=max(0,count-2)
    if not extra:return 0
    insertion=start+2; spans=[]
    for rng in list(ws.merged_cells.ranges):
        if rng.min_row<insertion<=rng.max_row:raise ValueError('Объединённая ячейка пересекает таблицу: '+ws.title)
        if rng.min_row>=insertion:
            spans.append((rng.min_col,rng.min_row,rng.max_col,rng.max_row));ws.unmerge_cells(str(rng))
    ws.insert_rows(insertion,extra)
    for a,b,c,d in spans:ws.merge_cells(start_row=b+extra,start_column=a,end_row=d+extra,end_column=c)
    for rr in range(insertion,insertion+extra):
        ws.row_dimensions[rr].height=ws.row_dimensions[start].height
        for col in range(1,ws.max_column+1):
            source=ws.cell(start,col);target=ws.cell(rr,col)
            if source.has_style:target._style=copy.copy(source._style)
            target.alignment=copy.copy(source.alignment);target.protection=copy.copy(source.protection)
    return extra

def row_values(ws,row,values):
    for col,value in enumerate(values,1):
        cell=ws.cell(row,col)
        if isinstance(cell,MergedCell):continue
        cell.value=value
        if isinstance(value,str):cell.data_type='s'
        if col in (2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17):cell.alignment=Alignment(vertical='top',wrap_text=True)
    desc=next((str(v) for v in values if isinstance(v,str) and len(v)>45),'')
    if desc:ws.row_dimensions[row].height=min(409,max(ws.row_dimensions[row].height or 15,15+14*((len(desc)+69)//70)))

def main():
    payload=json.load(sys.stdin);w=payload['work'];items=w.get('items') or []
    if not items or len(items)>1000:raise ValueError('Нужны от 1 до 1000 товарных позиций.')
    path=os.environ.get('INVOICE_TEMPLATE_PATH','')
    if not path or not os.path.isfile(path):raise ValueError('Шаблон комплекта не найден.')
    book=load_workbook(path)
    if book.sheetnames!=NAMES or book['INV']['A16'].value!='No.':raise ValueError('Структура шаблона не совпадает с утверждённым образцом.')
    # Formulas in the sample are tied to two example lines and to sample dates.
    # Fill actual, validated values instead; no stale cached results are kept.
    for ws in book:
        for row in ws:
            for c in row:
                if not isinstance(c,MergedCell) and c.data_type=='f':c.value=None
    book.properties.creator='';book.properties.lastModifiedBy='';book.properties.title='';book.properties.subject='';book.properties.description=''
    seller=w.get('seller') or {};shipper=w.get('shipper') or seller;buyer=w.get('buyer') or {};consignee=w.get('consignee') or {}
    no=w.get('number') or None;dt=date(w.get('date'));contract=w.get('contractNumber') or None;contract_date=date(w.get('contractDate'));terms=w.get('terms') or None
    payment=w.get('paymentTerms') or '';ru,sep,en=payment.partition('|');ru=ru.strip() or None;en=en.strip() if sep else None;currency=w.get('currency') or ''
    n=len(items); s1=expand(book['INV'],17,n);s2=expand(book['PAK'],19,n);s3=expand(book['Specification'],14,n);s4=expand(book['Price'],14,n);s5=expand(book['заявка-заказ'],7,n);s6=expand(book['ДЛЯ ДТ'],3,n)
    inv=book['INV'];pak=book['PAK'];spec=book['Specification'];price=book['Price'];order=book['заявка-заказ'];letter=book['Письмо о не страховании'];dt_sheet=book['ДЛЯ ДТ'];cmr=book['CMR']
    for addr,val in {'A2':seller.get('name'),'A5':no,'D5':dt,'G5':contract,'I5':contract_date,'A8':seller.get('name'),'A9':display_company(seller),'D8':buyer.get('name'),'D9':display_company(buyer),'A12':consignee.get('name'),'A13':None,'A14':display_company(consignee),'I16':f'Price, {currency}','K16':f'Amount, {currency}'}.items():setv(inv,addr,val)
    # Erase both sample positions, including auxiliary fields, before writing.
    for ws,start,cols in [(inv,17,11),(pak,19,10),(spec,14,15),(price,14,7),(order,7,6),(dt_sheet,3,26)]:
        for rr in range(start,start+max(2,n)):
            for col in range(1,cols+1):
                cell=ws.cell(rr,col)
                if not isinstance(cell,MergedCell):cell.value=None
    for i,x in enumerate(items):
        unit=x.get('unit') or None;name=x.get('name') or None;code=x.get('code') or None;maker=x.get('maker') or None;origin=x.get('origin') or None;brand=x.get('brand') or None;qty=num(x.get('quantity'));net=num(x.get('net'));gross=num(x.get('gross'));packages=num(x.get('packages'));pr=num(x.get('unitPrice'));amount=num(x.get('amount'));packaging=x.get('packaging') or None
        row_values(inv,17+i,[i+1,code,name,origin,brand,maker,net,qty,pr,unit,amount])
        row_values(pak,19+i,[i+1,code,name,maker,brand,packages,qty,net,gross,origin])
        row_values(spec,14+i,[i+1,name,brand,code,maker,origin,qty,packages,None,packaging,gross,net,pr,unit,amount])
        row_values(price,14+i,[i+1,name,brand,maker,pr,currency or None,unit])
        row_values(order,7+i,[i+1,name,None,maker,qty,unit])
        row_values(dt_sheet,3+i,[i+1,None,name,brand,brand,code,maker,origin,qty,packages,None,packaging,gross,net,pr,unit,amount,None,None,None,None,None,None,brand,None,None])
    units={str(x.get('unit') or '').strip().casefold() for x in items}
    tqty=total(items,'quantity') if len(units)==1 and '' not in units else None
    tnet=total(items,'net');tgross=total(items,'gross');tamount=total(items,'amount');tpackages=total(items,'packages')
    for addr,val in {f'G{19+s1}':tnet,f'H{19+s1}':tqty,f'K{19+s1}':tamount,f'A{22+s1}':tpackages,f'D{22+s1}':tgross,f'G{22+s1}':terms,f'A{25+s1}':en,f'A{26+s1}':ru,f'A{28+s1}':no,f'D{28+s1}':dt,f'C{30+s1}':None}.items():setv(inv,addr,val)
    # Recreate print area after variable rows.
    inv.print_area=f'A1:K{30+s1}'
    for addr,val in {'A1':seller.get('name'),'C4':no,'C5':dt,'B8':seller.get('name'),'D8':buyer.get('name'),'G8':consignee.get('name'),'B9':display_company(seller),'D9':display_company(buyer),'G9':display_company(consignee),'C11':contract,'E11':contract_date,'C13':terms,'B14':en,'C15':terms,'B16':ru,f'F{21+s2}':tpackages,f'G{21+s2}':tqty,f'H{21+s2}':tnet,f'I{21+s2}':tgross,f'C{24+s2}':tpackages,f'C{25+s2}':tgross,f'D{27+s2}':None}.items():setv(pak,addr,val)
    for addr,val in {'B1':f'СПЕЦИФИКАЦИЯ № {no}' if no else None,'B2':f'К контракту № {contract} от {contract_date.strftime("%d.%m.%Y")}' if contract and contract_date else None,'B3':None,'N3':dt,'B5':f'Покупатель: {buyer.get("name","")}; Продавец: {seller.get("name","")}; Получатель: {consignee.get("name","")}.','B9':None,'F9':None,'K9':None,'G10':None,'M10':None,'M13':currency or None,'O13':currency or None,f'G{16+s3}':tqty,f'H{16+s3}':tpackages,f'I{16+s3}':None,f'K{16+s3}':tgross,f'L{16+s3}':tnet,f'O{16+s3}':tamount,f'C{18+s3}':terms,f'B{19+s3}':en,f'C{20+s3}':terms,f'B{21+s3}':ru,f'B{24+s3}':buyer.get('name'),f'L{24+s3}':seller.get('name'),f'B{25+s3}':display_company(buyer),f'M{26+s3}':None,f'B{27+s3}':None,f'B{30+s3}':consignee.get('name'),f'B{31+s3}':display_company(consignee),f'B{33+s3}':None}.items():setv(spec,addr,val)
    for addr,val in {'A1':seller.get('name'),'C9':terms,'C10':None,'C11':None,f'B{18+s4}':'Director',f'B{19+s4}':None}.items():setv(price,addr,val)
    for addr,val in {'A1':buyer.get('name'),'A2':display_company(buyer),'A4':'CONTRACT:','C4':contract,'D4':contract_date,'E6':'QTY',f'E{9+s5}':tqty}.items():setv(order,addr,val)
    for addr,val in {'O2':currency or None,'Q2':currency or None,f'I{5+s6}':tqty,f'J{5+s6}':tpackages,f'K{5+s6}':None,f'L{5+s6}':None,f'M{5+s6}':tgross,f'N{5+s6}':tnet,f'P{5+s6}':None,f'Q{5+s6}':tamount}.items():setv(dt_sheet,addr,val)
    # A historical sample is not evidence that this shipment was uninsured.
    insured=w.get('insuranceStatus');letterText='Настоящим письмом уведомляем, что в рамках данной отгрузки страхование груза не осуществлялось.' if insured=='not_insured' else ('Груз застрахован. Письмо о нестраховании не применяется.' if insured=='insured' else 'ЧЕРНОВИК: статус страхования не подтверждён; письмо не сформировано.')
    for addr,val in {'A1':buyer.get('name'),'A2':display_company(buyer),'A4':letterText,'C5':contract,'D5':contract_date,'C6':no,'D6':dt,'C7':no,'D7':dt,'B11':'Директор','B12':None}.items():setv(letter,addr,val)
    transport=w.get('transport') or {}
    for addr,val in {'B9':transport.get('carrier'),'F9':transport.get('driver'),'K9':transport.get('vehicle'),'G10':transport.get('loadingPlace'),'M10':transport.get('deliveryPlace')}.items():setv(spec,addr,val)
    # Preserve the CMR form while explicitly clearing sample-specific declarations,
    # transport identifiers, dates and signatures which are not in the packing.
    for addr in ['E19','E21','I27','AS15','I35','I37','AS39','AS41','AD47','E49','E53','E65','T71','AD71','V82','N88','AH88','AP92','E103','S91','Y91','S94','Y94','BE91','CA91']:setv(cmr,addr,None)
    for addr,val in {'BS2':None,'E3':shipper.get('name'),'E5':display_company(shipper),'E13':consignee.get('name'),'E15':display_company(consignee),'V43':no,'AK43':dt,'T47':tpackages,'BM47':tgross,'Z51':no,'AO51':dt,'AS39':'ЧЕРНОВИК: транспортные данные не заполнены','V82':terms,'AS15':transport.get('carrier'),'I27':transport.get('deliveryPlace'),'I35':transport.get('loadingPlace'),'I37':date(transport.get('loadingDate')),'AP92':transport.get('driver'),'E103':transport.get('vehicle')}.items():setv(cmr,addr,val)
    if payload.get('final') is not True:
        inv['A1']='ПРЕДПРОСМОТР / COMMERCIAL INVOICE'
    # Excel can open all values immediately, without a recalculation engine.
    if book.calculation:book.calculation.fullCalcOnLoad=True
    result=io.BytesIO();book.save(result);sys.stdout.buffer.write(result.getvalue())

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(str(e),file=sys.stderr);sys.exit(1)
