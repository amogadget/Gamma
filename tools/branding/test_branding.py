"""The typing helper's SMIL must be well formed: every animation has one keyTime per
value, keyTimes start at 0 and end at 1 (a browser silently drops one that does not)."""
import re
import xml.etree.ElementTree as ET

from branding import FONT, MONO, typewriter


def animations(svg):
    root = ET.fromstring(f'<svg xmlns="http://www.w3.org/2000/svg">{svg}</svg>')
    return [el for el in root.iter() if el.tag.endswith('animate') or el.tag.endswith('animateTransform')]


def check(svg):
    found = animations(svg)
    assert found
    for el in found:
        values, times = el.get('values').split(';'), el.get('keyTimes').split(';')
        assert len(values) == len(times), (el.get('attributeName'), values, times)
        assert float(times[0]) == 0 and float(times[-1]) == 1, times
        assert [float(t) for t in times] == sorted(float(t) for t in times)


def test_typewriter_animations_are_well_formed():
    for family in (FONT, MONO):
        check(typewriter('Add the lifetime data.', 10, 30, 8, 0.5, 3, family=family, label=('Maya', '#287956')))
    check(typewriter('x', 0, 0, 5, 0, 1))


def test_characters_land_in_order_and_on_time():
    svg = typewriter('ab c', 0, 0, 10, 1, 4)
    landed = [float(m.split(';')[1]) * 10 for m in re.findall(r'values="0;1;0;0" keyTimes="([^"]+)"', svg)][:4]  # the characters, then the caret and tag
    assert len(landed) == 4 and landed == sorted(landed)
    assert 1 < landed[0] and abs(landed[-1] - 4) < 1e-6


def test_special_characters_are_escaped():
    svg = typewriter('a<b&c', 0, 0, 5, 0, 1)
    assert '&lt;' in svg and '&amp;' in svg
    ET.fromstring(f'<svg xmlns="http://www.w3.org/2000/svg">{svg}</svg>')
