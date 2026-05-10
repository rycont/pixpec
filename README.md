# pixpec

Pixpec is what you get if you treat UI as a compilation problem: a Figma file parses into a target-agnostic intermediate representation, a backend lowers it to a runtime (React + PandaCSS today), and a pixel-level verifier — DFS through the design tree, LAB ΔE00 against the source — proves the lowering preserved visual semantics. Working end-to-end on a real design system, with sub-pixel anti-aliasing as the only observed loss. The hypothesis: the per-framework, per-platform, per-team rewrite of every design isn't a craft — it's missing infrastructure.

---

Pixpec은 UI를 컴파일 문제로 다룬다. Figma 파일이 target-agnostic IR로 파싱되고, 백엔드가 IR을 런타임으로 lowering하며 (오늘은 React + PandaCSS), 픽셀 단위 검증기 — 디자인 트리를 DFS 순회하며 원본과 LAB ΔE00 비교 — 가 lowering이 visual semantic을 보존했음을 증명한다. 실제 디자인 시스템을 대상으로 end-to-end로 동작 중이며, 관찰되는 유일한 손실은 글자 가장자리의 sub-pixel anti-aliasing뿐이다. 가설: 모든 디자인을 프레임워크마다, 플랫폼마다, 팀마다 다시 짜는 일은 craft가 아니라 infrastructure의 부재다.
