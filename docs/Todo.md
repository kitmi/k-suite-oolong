# Todo Features

## type with modifiers and hoisted field reference 

## add qualifiers into validators

## add triggers for calculated fields

## data template

## join with logicalDeletion

## field query able, update key

## create or update by related record value

## condition translation, e.g. 
  query status=In-progress
  translate to status=Open or status=Pending

## triggers for insert and update

## query operators



  triggers
    onCreate
      
    onUpdate
      alwaysDo
        netAmount |=multiply(@latest.quantity, @latest.adjustedUnitPrice |>ifNullSetTo(@latest.unitPrice)
        subTotal |=sum(@latest.netAmount, @latest.taxAmount)
      when status changed
        from 'Quote' to 'Unpaid'
          expiryDate |=dateAdd(@@now, )