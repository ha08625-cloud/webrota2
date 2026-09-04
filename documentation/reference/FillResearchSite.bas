Sub FillResearchSite()
    '
    ' FillResearchSite Macro
    ' Fills in all standard sections of the Site Identification Form
    '
    
    Dim tbl As Table
    Dim cell As cell
    Dim targetCell As cell
    
    ' Loop through all tables in the document
    For Each tbl In ActiveDocument.Tables
        
        ' Loop through each cell in the table
        For Each cell In tbl.Range.Cells
            
            ' SECTION 1: RESEARCH SITE
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Research site") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Summertown Health Centre"
                        .InsertParagraphAfter
                        .InsertAfter "160 Banbury Road"
                        .InsertParagraphAfter
                        .InsertAfter "Oxford"
                        .InsertParagraphAfter
                        .InsertAfter "OX2 7BS"
                        .InsertParagraphAfter
                        .InsertAfter "K84011"
                    End With
                End If
                
            End If
            
            
            ' SECTION 2: INVESTIGATOR
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Investigator") > 0 And _
               InStr(cell.Range.Text, "Research site") = 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Name and Role: Dr Charlie Luo"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Email: charlie.luo@nhs.net"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Telephone: 01865 515552"
                    End With
                End If
            End If
            
            
            ' SECTION 3: MAIN CONTACT FOR FEASIBILITY DISCUSSIONS
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Main contact") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Name and Role: Dr Charlie Luo"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Email: charlie.luo@nhs.net"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Telephone: 01865 515552"
                    End With
                End If
            End If
            
            
            ' SECTION 4: RESEARCH SETTING (PRIMARY CARE)
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Primary Care") > 0 And _
               InStr(cell.Range.Text, "Y/N") > 0 Then
                
                cell.Range.Text = "Primary Care Y"
            End If
            
            
            ' SECTION 5: SUPPORTING NETWORK
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Supporting Network") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "South Central RRRN sc.rrdn@nihr.ac.uk"
                        .InsertParagraphAfter
                        .InsertAfter "sc.rrdn@nihr.ac.uk"
                    End With
                End If
            End If
            
            
            ' SECTION 6: PARTICIPANT RECRUITMENT
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Where and how will") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Summertown Health Centre is based in Oxfordshire and has a stable patient population of approx. 19,000"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "The GP Practice holds electronic patient records which are coded. From the application of a bespoke search via our clinical system EMIS, based on the inclusion and exclusion criteria, eligible patients can easily be identified."
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "In addition, patients can also be identified when contacting us directly or via remote consultations."
                    End With
                End If
            End If
            
            
            ' SECTION 7: STAFF RESOURCE
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "outline the staff resource") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Summertown Health Centre has a dedicated GCP trained research team. This comprises:"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "-   Principal Investigator"
                        .InsertParagraphAfter
                        .InsertAfter "-   Co-Investigators"
                        .InsertParagraphAfter
                        .InsertAfter "-   Research Nurse Manager"
                        .InsertParagraphAfter
                        .InsertAfter "-   Research Nurse and Health Care Assistant"
                        .InsertParagraphAfter
                        .InsertAfter "-   Operations Manager"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Study set up can be quick, subject to regulatory approvals and sponsor requirements"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "The research team have the relevant experience according to the Schedule of Assessments provided."
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "They are familiar with the requirements for collection, processing and packing of blood samples for both central and local labs"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Data entry and query resolution would be completed in accordance with the sponsor requirements."
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "We have significant experience of providing instructions/training to patients for the use of study"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "specific requirements, and the use of technologies. In addition, we are familiar with collecting patient"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "reported outcomes via questionnaires and e-diaries"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Research Nurse support can also be provided by the experienced CRN: Thames Valley and South Midlands (TVSM) Primary Care Research Nurse Team as required. See below for detail."
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "The GP Practice is also supported by the Commercial Research Manager who can provide support for study set up, including the review of the Industry Costing Template. The study will be performance managed to ensure delivery of the study to time and target."
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Our CQC (Care Quality Commission) Inspection rating = Good (September 2016)"
                    End With
                End If
            End If
            
            
            ' SECTION 8: INFRASTRUCTURE
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "other infrastructure") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Based on the information provided, Summertown Health Centre can provide the following facilities to conduct this study:"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "-   Clinic room capacity"
                        .InsertParagraphAfter
                        .InsertAfter "-   Secure storage, with limited access"
                        .InsertParagraphAfter
                        .InsertAfter "-   Standard clinical equipment"
                        .InsertParagraphAfter
                        .InsertAfter "-   Drug cupboard with external thermometer, not a clinical grade medication cupboard"
                        .InsertParagraphAfter
                        .InsertAfter "-   Vaccine fridge(s) with temperature monitoring? Vaccine fridges have integral thermometers, fridge temps monitored twice daily by the nursing team. Also have separate data loggers which are downloaded monthly unless cold chain breach, then downloaded immediately"
                        .InsertParagraphAfter
                        .InsertAfter "-   Capacity to accommodate remote and on site monitoring visits with NHS Wi-Fi access"
                        .InsertParagraphAfter
                        .InsertAfter "Calibration certificates can be provided"
                        .InsertParagraphAfter
                        .InsertAfter "-   Willing to source / hire any specialist equipment for a study if selected"
                    End With
                End If
            End If
            
            
            ' SECTION 9: SITE-SPECIFIC ACTIVITIES
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "site-specific activities") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "Confirmation of capacity and capability is provided by the GP Practice. The timelines for study set up are influenced by the provision of HRA Approval"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Alternatives to the national templates used (ABPI model agreement or industry costing template): No"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Any other site-specific activities to highlight: No"
                    End With
                End If
            End If
            
            
            ' SECTION 10: NON-COMMERCIAL STUDIES
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "Non-Commercial") > 0 And _
               InStr(cell.Range.Text, "Studies") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    If Len(Trim(targetCell.Range.Text)) < 50 Then
                        targetCell.Range.Text = ""
                        With targetCell.Range
                            .InsertAfter "Summertown Health centre has a wealth of experience in running non-commercial studies."
                            .InsertParagraphAfter
                            .InsertParagraphAfter
                            .InsertAfter "32 non-commercial studies have been running at Summertown Health Centre during the period April 2021 -- to date, with a collective recruitment of 960 (ODP 2023-04-06)"
                        End With
                    End If
                End If
            End If
            
            
            ' SECTION 11: NETWORK SUPPORT
            ' ------------------------------------------------------------------
            If InStr(cell.Range.Text, "unique elements of Network") > 0 Then
                
                On Error Resume Next
                Set targetCell = tbl.cell(cell.RowIndex, cell.ColumnIndex + 1)
                On Error GoTo 0
                
                If Not targetCell Is Nothing Then
                    targetCell.Range.Text = ""
                    With targetCell.Range
                        .InsertAfter "We have previous experience recruiting to the commercial studies below:"
                        .InsertParagraphAfter
                        .InsertAfter "Localised Neuropathic Pain – target of 15 reached with 100% retention rate"
                        .InsertParagraphAfter
                        .InsertAfter "Diabetes study – target of 2 reached with 100% retention rate"
                        .InsertParagraphAfter
                        .InsertAfter "Summertown Health centre has a wealth of experience in running non-commercial studies"
                        .InsertParagraphAfter
                        .InsertAfter "13 non-commercial studies have been running at Summertown Health Centre during the period FY 23/ 24 and FY 24/25 , with a collective recruitment of 840 (ODP reporting, Feb 2025)"
                        .InsertParagraphAfter
                        .InsertParagraphAfter
                        .InsertAfter "Support may be provided by SC RRDN agile team on request."
                    End With
                End If
            End If
            
        Next cell
        
    Next tbl
    
    ' Show success message
    MsgBox "Form has been filled in successfully!", vbInformation

End Sub


