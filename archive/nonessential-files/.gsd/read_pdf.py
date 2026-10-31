import zlib, base64, re

def dump_pdf(path):
    print(f"=== {path} ===")
    with open(path, 'rb') as f:
        data = f.read()
    
    # find all streams
    idx = 0
    while True:
        s_idx = data.find(b'stream', idx)
        if s_idx == -1: break
        e_idx = data.find(b'endstream', s_idx)
        if e_idx == -1: break
        
        # get preceding dict
        dict_part = data[max(0, s_idx-150):s_idx]
        stream_data = data[s_idx+6:e_idx].strip()
        
        # try ascii85 decode
        to_dec = stream_data
        if not to_dec.startswith(b'<~'): to_dec = b'<~' + to_dec
        if not to_dec.endswith(b'~>'): to_dec = to_dec + b'~>'
        
        try:
            a85 = base64.a85decode(to_dec, adobe=True)
            flate = zlib.decompress(a85)
            text_lines = [l for l in flate.decode('latin1', errors='ignore').splitlines() if '(' in l and ')' in l]
            print(f"Stream at {s_idx} (ASCII85+Flate, {len(text_lines)} text lines):")
            for l in text_lines[:25]:
                # extract parens
                strs = re.findall(r'\((.*?)\)', l)
                if strs:
                    print("  ", " ".join(strs))
        except Exception as e:
            # try direct flate
            try:
                flate = zlib.decompress(stream_data)
                text_lines = [l for l in flate.decode('latin1', errors='ignore').splitlines() if '(' in l and ')' in l]
                print(f"Stream at {s_idx} (Direct Flate, {len(text_lines)} text lines):")
                for l in text_lines[:25]:
                    strs = re.findall(r'\((.*?)\)', l)
                    if strs:
                        print("  ", " ".join(strs))
            except Exception as e2:
                pass
        idx = e_idx + 9

dump_pdf('.gsd/reference_audit/Workflow references/Sample Approval Workflow.pdf')
dump_pdf('.gsd/reference_audit/Reports and documents/Financial Project Sample.pdf')
