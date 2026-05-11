/**
 * Sample background pixel values from figma vs slint Status=true outputs
 * to check whether the gray bg has a measurable color shift.
 */
import sharp from 'sharp'

const F = '/home/rycont/dev/pixpec-workdir/danah/.pixpec-out/_slint-bd/4108_1696/BD_4108_1696/_work'

async function sample(path: string) {
  const { data, info } = await sharp(path).flatten({ background: '#fff' }).raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const px = (x: number, y: number) => {
    const i = (y * w + x) * 3
    return [data[i], data[i + 1], data[i + 2]]
  }
  console.log('  outer bg (10,10):           ', px(10, 10))
  console.log('  outer bg (1500,300):        ', px(1500, 300))
  console.log('  inside white pill (200,140):', px(200, 140))
  console.log('  between pills (800,200):    ', px(800, 200))
  console.log('  outer bg (50, 380):         ', px(50, 380))
}
console.log('--- figma ---')
await sample(`${F}/figma/BD_4108_1696.png`)
console.log('--- slint ---')
await sample(`${F}/chromium/BD_4108_1696.png`)
