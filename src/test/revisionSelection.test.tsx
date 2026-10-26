// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BatchProcess from '@/pages/BatchProcess';
import { calculateMatrix } from '@/lib/colorCorrection';
import { savePreset } from '@/lib/presetStorage';
import type { ColorPoint, CalibrationPreset } from '@/types/colorCorrector';

const white: ColorPoint = {
  id: 'white',
  label: 'White',
  role: 'white',
  x: 0.1,
  y: 0.1,
  sampledColor: { r: 220, g: 210, b: 200 },
  targetColor: { r: 255, g: 255, b: 255 },
};
const black: ColorPoint = {
  id: 'black',
  label: 'Black',
  role: 'black',
  x: 0.9,
  y: 0.9,
  sampledColor: { r: 15, g: 12, b: 10 },
  targetColor: { r: 0, g: 0, b: 0 },
};

function makePreset(): CalibrationPreset {
  const points = [white, black];
  return {
    id: 'preset_revision_test',
    name: 'Revision Test',
    createdAt: 1000,
    updatedAt: 1000,
    points,
    matrix: calculateMatrix(points, 'simple'),
    mode: 'simple',
  };
}

function renderBatch(state?: Record<string, unknown>) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/batch', state }]}>
      <Routes>
        <Route path="/batch" element={<BatchProcess />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe('batch workflow revision selection', () => {
  it('does not select a revision implicitly when a preset is chosen', () => {
    const saved = savePreset(makePreset());
    savePreset({
      ...makePreset(),
      points: [{ ...white, targetColor: { r: 250, g: 250, b: 250 } }, black],
      matrix: calculateMatrix([{ ...white, targetColor: { r: 250, g: 250, b: 250 } }, black], 'simple'),
    });

    renderBatch({ presetId: saved.id });

    expect(screen.getByText(/No revision selected/i)).toBeTruthy();
    expect(screen.getByText(/Revision \(required/i)).toBeTruthy();
    expect(screen.queryByText(/Using: Revision Test — revision/i)).toBeNull();
  });

  it('shows the explicitly supplied revision', () => {
    savePreset(makePreset());
    savePreset({
      ...makePreset(),
      points: [{ ...white, targetColor: { r: 250, g: 250, b: 250 } }, black],
      matrix: calculateMatrix([{ ...white, targetColor: { r: 250, g: 250, b: 250 } }, black], 'simple'),
    });

    renderBatch({ presetId: 'preset_revision_test', revision: 2 });

    expect(screen.getByText(/Using: Revision Test — revision 2/i)).toBeTruthy();
  });
});
