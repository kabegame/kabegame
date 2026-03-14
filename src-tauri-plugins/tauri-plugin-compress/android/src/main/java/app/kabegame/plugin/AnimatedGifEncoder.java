package app.kabegame.plugin;

import android.graphics.Bitmap;
import android.graphics.Bitmap.Config;
import android.graphics.Canvas;
import android.graphics.Paint;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Animated GIF encoder (wasabeef gist, adapted for app.kabegame.plugin). Used for generating video
 * GIF thumbnails on Android.
 */
public class AnimatedGifEncoder {

  protected int width; // image size
  protected int height;
  protected int x = 0;
  protected int y = 0;
  protected int transparent = -1; // transparent color if given
  protected int transIndex; // transparent index in color table
  protected int repeat = -1; // no repeat
  protected int delay = 0; // frame delay (hundredths)
  protected boolean started = false; // ready to output frames
  protected OutputStream out;
  protected Bitmap image; // current frame
  protected byte[] pixels; // BGR byte array from frame
  protected byte[] indexedPixels; // converted frame indexed to palette
  protected int colorDepth; // number of bit planes
  protected byte[] colorTab; // RGB palette
  protected boolean[] usedEntry = new boolean[256]; // active palette entries
  protected int palSize = 7; // color table size (bits-1)
  protected int dispose = -1; // disposal code (-1 = use default)
  protected boolean closeStream = false; // close stream when finished
  protected boolean firstFrame = true;
  protected boolean sizeSet = false; // if false, get size from first frame
  protected int sample = 10; // default sample interval for quantizer

  public void setDelay(int ms) {
    delay = ms / 10;
  }

  public void setDispose(int code) {
    if (code >= 0) {
      dispose = code;
    }
  }

  public void setRepeat(int iter) {
    if (iter >= 0) {
      repeat = iter;
    }
  }

  public void setTransparent(int c) {
    transparent = c;
  }

  public boolean addFrame(Bitmap im) {
    if ((im == null) || !started) {
      return false;
    }
    boolean ok = true;
    try {
      if (!sizeSet) {
        setSize(im.getWidth(), im.getHeight());
      }
      image = im;
      getImagePixels();
      analyzePixels();
      if (firstFrame) {
        writeLSD();
        writePalette();
        if (repeat >= 0) {
          writeNetscapeExt();
        }
      }
      writeGraphicCtrlExt();
      writeImageDesc();
      if (!firstFrame) {
        writePalette();
      }
      writePixels();
      firstFrame = false;
    } catch (IOException e) {
      ok = false;
    }

    return ok;
  }

  public boolean finish() {
    if (!started) return false;
    boolean ok = true;
    started = false;
    try {
      out.write(0x3b); // gif trailer
      out.flush();
      if (closeStream) {
        out.close();
      }
    } catch (IOException e) {
      ok = false;
    }

    transIndex = 0;
    out = null;
    image = null;
    pixels = null;
    indexedPixels = null;
    colorTab = null;
    closeStream = false;
    firstFrame = true;

    return ok;
  }

  public void setFrameRate(float fps) {
    if (fps != 0f) {
      delay = (int) (100 / fps);
    }
  }

  public void setQuality(int quality) {
    if (quality < 1) quality = 1;
    sample = quality;
  }

  public void setSize(int w, int h) {
    width = w;
    height = h;
    if (width < 1) width = 320;
    if (height < 1) height = 240;
    sizeSet = true;
  }

  public void setPosition(int x, int y) {
    this.x = x;
    this.y = y;
  }

  public boolean start(OutputStream os) {
    if (os == null) return false;
    boolean ok = true;
    closeStream = false;
    out = os;
    try {
      writeString("GIF89a");
    } catch (IOException e) {
      ok = false;
    }
    return started = ok;
  }

  protected void analyzePixels() {
    int len = pixels.length;
    int nPix = len / 3;
    indexedPixels = new byte[nPix];
    NeuQuant nq = new NeuQuant(pixels, len, sample);
    colorTab = nq.process();
    for (int i = 0; i < colorTab.length; i += 3) {
      byte temp = colorTab[i];
      colorTab[i] = colorTab[i + 2];
      colorTab[i + 2] = temp;
      usedEntry[i / 3] = false;
    }
    int k = 0;
    for (int i = 0; i < nPix; i++) {
      int index = nq.map(pixels[k++] & 0xff, pixels[k++] & 0xff, pixels[k++] & 0xff);
      usedEntry[index] = true;
      indexedPixels[i] = (byte) index;
    }
    pixels = null;
    colorDepth = 8;
    palSize = 7;
    if (transparent != -1) {
      transIndex = findClosest(transparent);
    }
  }

  protected int findClosest(int c) {
    if (colorTab == null) return -1;
    int r = (c >> 16) & 0xff;
    int g = (c >> 8) & 0xff;
    int b = (c >> 0) & 0xff;
    int minpos = 0;
    int dmin = 256 * 256 * 256;
    int len = colorTab.length;
    for (int i = 0; i < len; ) {
      int dr = r - (colorTab[i++] & 0xff);
      int dg = g - (colorTab[i++] & 0xff);
      int db = b - (colorTab[i] & 0xff);
      int d = dr * dr + dg * dg + db * db;
      int index = i / 3;
      if (usedEntry[index] && (d < dmin)) {
        dmin = d;
        minpos = index;
      }
      i++;
    }
    return minpos;
  }

  protected void getImagePixels() {
    int w = image.getWidth();
    int h = image.getHeight();
    if ((w != width) || (h != height)) {
      Bitmap temp = Bitmap.createBitmap(width, height, Config.RGB_565);
      Canvas g = new Canvas(temp);
      g.drawBitmap(image, 0, 0, new Paint());
      image = temp;
    }
    int[] data = getImageData(image);
    pixels = new byte[data.length * 3];
    for (int i = 0; i < data.length; i++) {
      int td = data[i];
      int tind = i * 3;
      pixels[tind++] = (byte) ((td >> 0) & 0xFF);
      pixels[tind++] = (byte) ((td >> 8) & 0xFF);
      pixels[tind] = (byte) ((td >> 16) & 0xFF);
    }
  }

  protected int[] getImageData(Bitmap img) {
    int w = img.getWidth();
    int h = img.getHeight();

    int[] data = new int[w * h];
    img.getPixels(data, 0, w, 0, 0, w, h);
    return data;
  }

  protected void writeGraphicCtrlExt() throws IOException {
    out.write(0x21);
    out.write(0xf9);
    out.write(4);
    int transp, disp;
    if (transparent == -1) {
      transp = 0;
      disp = 0;
    } else {
      transp = 1;
      disp = 2;
    }
    if (dispose >= 0) {
      disp = dispose & 7;
    }
    disp <<= 2;

    out.write(0 | disp | 0 | transp);

    writeShort(delay);
    out.write(transIndex);
    out.write(0);
  }

  protected void writeImageDesc() throws IOException {
    out.write(0x2c);
    writeShort(x);
    writeShort(y);
    writeShort(width);
    writeShort(height);
    if (firstFrame) {
      out.write(0);
    } else {
      out.write(0x80 | 0 | 0 | 0 | palSize);
    }
  }

  protected void writeLSD() throws IOException {
    writeShort(width);
    writeShort(height);
    out.write((0x80 | 0x70 | 0x00 | palSize));

    out.write(0);
    out.write(0);
  }

  protected void writeNetscapeExt() throws IOException {
    out.write(0x21);
    out.write(0xff);
    out.write(11);
    writeString("NETSCAPE" + "2.0");
    out.write(3);
    out.write(1);
    writeShort(repeat);
    out.write(0);
  }

  protected void writePalette() throws IOException {
    out.write(colorTab, 0, colorTab.length);
    int n = (3 * 256) - colorTab.length;
    for (int i = 0; i < n; i++) {
      out.write(0);
    }
  }

  protected void writePixels() throws IOException {
    LZWEncoder encoder = new LZWEncoder(width, height, indexedPixels, colorDepth);
    encoder.encode(out);
  }

  protected void writeShort(int value) throws IOException {
    out.write(value & 0xff);
    out.write((value >> 8) & 0xff);
  }

  protected void writeString(String s) throws IOException {
    for (int i = 0; i < s.length(); i++) {
      out.write((byte) s.charAt(i));
    }
  }
}

/*
 * NeuQuant Neural-Net Quantization Algorithm - Anthony Dekker 1994.
 * Ported to Java 12/00 K Weiner.
 */
class NeuQuant {

  protected static final int netsize = 256;
  protected static final int prime1 = 499;
  protected static final int prime2 = 491;
  protected static final int prime3 = 487;
  protected static final int prime4 = 503;
  protected static final int minpicturebytes = (3 * prime4);
  protected static final int maxnetpos = (netsize - 1);
  protected static final int netbiasshift = 4;
  protected static final int ncycles = 100;
  protected static final int intbiasshift = 16;
  protected static final int intbias = (((int) 1) << intbiasshift);
  protected static final int gammashift = 10;
  protected static final int gamma = (((int) 1) << gammashift);
  protected static final int betashift = 10;
  protected static final int beta = (intbias >> betashift);
  protected static final int betagamma = (intbias << (gammashift - betashift));
  protected static final int initrad = (netsize >> 3);
  protected static final int radiusbiasshift = 6;
  protected static final int radiusbias = (((int) 1) << radiusbiasshift);
  protected static final int initradius = (initrad * radiusbias);
  protected static final int radiusdec = 30;
  protected static final int alphabiasshift = 10;
  protected static final int initalpha = (((int) 1) << alphabiasshift);
  protected int alphadec;
  protected static final int radbiasshift = 8;
  protected static final int radbias = (((int) 1) << radbiasshift);
  protected static final int alpharadbshift = (alphabiasshift + radbiasshift);
  protected static final int alpharadbias = (((int) 1) << alpharadbshift);

  protected byte[] thepicture;
  protected int lengthcount;
  protected int samplefac;
  protected int[][] network;
  protected int[] netindex = new int[256];
  protected int[] bias = new int[netsize];
  protected int[] freq = new int[netsize];
  protected int[] radpower = new int[initrad];

  public NeuQuant(byte[] thepic, int len, int sample) {
    int i;
    int[] p;

    thepicture = thepic;
    lengthcount = len;
    samplefac = sample;

    network = new int[netsize][];
    for (i = 0; i < netsize; i++) {
      network[i] = new int[4];
      p = network[i];
      p[0] = p[1] = p[2] = (i << (netbiasshift + 8)) / netsize;
      freq[i] = intbias / netsize;
      bias[i] = 0;
    }
  }

  public byte[] colorMap() {
    byte[] map = new byte[3 * netsize];
    int[] index = new int[netsize];
    for (int i = 0; i < netsize; i++) index[network[i][3]] = i;
    int k = 0;
    for (int i = 0; i < netsize; i++) {
      int j = index[i];
      map[k++] = (byte) (network[j][0]);
      map[k++] = (byte) (network[j][1]);
      map[k++] = (byte) (network[j][2]);
    }
    return map;
  }

  public void inxbuild() {
    int i, j, smallpos, smallval;
    int[] p;
    int[] q;
    int previouscol, startpos;

    previouscol = 0;
    startpos = 0;
    for (i = 0; i < netsize; i++) {
      p = network[i];
      smallpos = i;
      smallval = p[1];
      for (j = i + 1; j < netsize; j++) {
        q = network[j];
        if (q[1] < smallval) {
          smallpos = j;
          smallval = q[1];
        }
      }
      q = network[smallpos];
      if (i != smallpos) {
        int jv;
        jv = q[0];
        q[0] = p[0];
        p[0] = jv;
        jv = q[1];
        q[1] = p[1];
        p[1] = jv;
        jv = q[2];
        q[2] = p[2];
        p[2] = jv;
        jv = q[3];
        q[3] = p[3];
        p[3] = jv;
      }
      if (smallval != previouscol) {
        netindex[previouscol] = (startpos + i) >> 1;
        for (j = previouscol + 1; j < smallval; j++) netindex[j] = i;
        previouscol = smallval;
        startpos = i;
      }
    }
    netindex[previouscol] = (startpos + maxnetpos) >> 1;
    for (j = previouscol + 1; j < 256; j++) netindex[j] = maxnetpos;
  }

  public void learn() {
    int i, j, b, g, r;
    int radius, rad, alpha, step, delta, samplepixels;
    byte[] p;
    int pix, lim;

    if (lengthcount < minpicturebytes) samplefac = 1;
    alphadec = 30 + ((samplefac - 1) / 3);
    p = thepicture;
    pix = 0;
    lim = lengthcount;
    samplepixels = lengthcount / (3 * samplefac);
    delta = samplepixels / ncycles;
    alpha = initalpha;
    radius = initradius;

    rad = radius >> radiusbiasshift;
    if (rad <= 1) rad = 0;
    for (i = 0; i < rad; i++) radpower[i] = alpha * (((rad * rad - i * i) * radbias) / (rad * rad));

    if (lengthcount < minpicturebytes) step = 3;
    else if ((lengthcount % prime1) != 0) step = 3 * prime1;
    else {
      if ((lengthcount % prime2) != 0) step = 3 * prime2;
      else {
        if ((lengthcount % prime3) != 0) step = 3 * prime3;
        else step = 3 * prime4;
      }
    }

    i = 0;
    while (i < samplepixels) {
      b = (p[pix + 0] & 0xff) << netbiasshift;
      g = (p[pix + 1] & 0xff) << netbiasshift;
      r = (p[pix + 2] & 0xff) << netbiasshift;
      j = contest(b, g, r);

      altersingle(alpha, j, b, g, r);
      if (rad != 0) alterneigh(rad, j, b, g, r);

      pix += step;
      if (pix >= lim) pix -= lengthcount;

      i++;
      if (delta == 0) delta = 1;
      if (i % delta == 0) {
        alpha -= alpha / alphadec;
        radius -= radius / radiusdec;
        rad = radius >> radiusbiasshift;
        if (rad <= 1) rad = 0;
        for (j = 0; j < rad; j++)
          radpower[j] = alpha * (((rad * rad - j * j) * radbias) / (rad * rad));
      }
    }
  }

  public int map(int b, int g, int r) {
    int i, j, dist, a, bestd;
    int[] p;
    int best;

    bestd = 1000;
    best = -1;
    i = netindex[g];
    j = i - 1;

    while ((i < netsize) || (j >= 0)) {
      if (i < netsize) {
        p = network[i];
        dist = p[1] - g;
        if (dist >= bestd) i = netsize;
        else {
          i++;
          if (dist < 0) dist = -dist;
          a = p[0] - b;
          if (a < 0) a = -a;
          dist += a;
          if (dist < bestd) {
            a = p[2] - r;
            if (a < 0) a = -a;
            dist += a;
            if (dist < bestd) {
              bestd = dist;
              best = p[3];
            }
          }
        }
      }
      if (j >= 0) {
        p = network[j];
        dist = g - p[1];
        if (dist >= bestd) j = -1;
        else {
          j--;
          if (dist < 0) dist = -dist;
          a = p[0] - b;
          if (a < 0) a = -a;
          dist += a;
          if (dist < bestd) {
            a = p[2] - r;
            if (a < 0) a = -a;
            dist += a;
            if (dist < bestd) {
              bestd = dist;
              best = p[3];
            }
          }
        }
      }
    }
    return (best);
  }

  public byte[] process() {
    learn();
    unbiasnet();
    inxbuild();
    return colorMap();
  }

  public void unbiasnet() {
    int i;

    for (i = 0; i < netsize; i++) {
      network[i][0] >>= netbiasshift;
      network[i][1] >>= netbiasshift;
      network[i][2] >>= netbiasshift;
      network[i][3] = i;
    }
  }

  protected void alterneigh(int rad, int i, int b, int g, int r) {
    int j, k, lo, hi, a, m;
    int[] p;

    lo = i - rad;
    if (lo < -1) lo = -1;
    hi = i + rad;
    if (hi > netsize) hi = netsize;

    j = i + 1;
    k = i - 1;
    m = 1;
    while ((j < hi) || (k > lo)) {
      a = radpower[m++];
      if (j < hi) {
        p = network[j++];
        try {
          p[0] -= (a * (p[0] - b)) / alpharadbias;
          p[1] -= (a * (p[1] - g)) / alpharadbias;
          p[2] -= (a * (p[2] - r)) / alpharadbias;
        } catch (Exception e) {
        }
      }
      if (k > lo) {
        p = network[k--];
        try {
          p[0] -= (a * (p[0] - b)) / alpharadbias;
          p[1] -= (a * (p[1] - g)) / alpharadbias;
          p[2] -= (a * (p[2] - r)) / alpharadbias;
        } catch (Exception e) {
        }
      }
    }
  }

  protected void altersingle(int alpha, int i, int b, int g, int r) {
    int[] n = network[i];
    n[0] -= (alpha * (n[0] - b)) / initalpha;
    n[1] -= (alpha * (n[1] - g)) / initalpha;
    n[2] -= (alpha * (n[2] - r)) / initalpha;
  }

  protected int contest(int b, int g, int r) {
    int i, dist, a, biasdist, betafreq;
    int bestpos, bestbiaspos, bestd, bestbiasd;
    int[] n;

    bestd = ~(((int) 1) << 31);
    bestbiasd = bestd;
    bestpos = -1;
    bestbiaspos = bestpos;

    for (i = 0; i < netsize; i++) {
      n = network[i];
      dist = n[0] - b;
      if (dist < 0) dist = -dist;
      a = n[1] - g;
      if (a < 0) a = -a;
      dist += a;
      a = n[2] - r;
      if (a < 0) a = -a;
      dist += a;
      if (dist < bestd) {
        bestd = dist;
        bestpos = i;
      }
      biasdist = dist - ((bias[i]) >> (intbiasshift - netbiasshift));
      if (biasdist < bestbiasd) {
        bestbiasd = biasdist;
        bestbiaspos = i;
      }
      betafreq = (freq[i] >> betashift);
      freq[i] -= betafreq;
      bias[i] += (betafreq << gammashift);
    }
    freq[bestpos] += beta;
    bias[bestpos] -= betagamma;
    return (bestbiaspos);
  }
}

class LZWEncoder {

  private static final int EOF = -1;

  private int imgW, imgH;
  private byte[] pixAry;
  private int initCodeSize;
  private int remaining;
  private int curPixel;

  static final int BITS = 12;
  static final int HSIZE = 5003;

  int n_bits;
  int maxbits = BITS;
  int maxcode;
  int maxmaxcode = 1 << BITS;
  int[] htab = new int[HSIZE];
  int[] codetab = new int[HSIZE];
  int hsize = HSIZE;
  int free_ent = 0;
  boolean clear_flg = false;

  int g_init_bits;
  int ClearCode;
  int EOFCode;

  int cur_accum = 0;
  int cur_bits = 0;
  int masks[] = {
    0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F, 0x00FF, 0x01FF, 0x03FF, 0x07FF,
    0x0FFF, 0x1FFF, 0x3FFF, 0x7FFF, 0xFFFF
  };

  int a_count;
  byte[] accum = new byte[256];

  LZWEncoder(int width, int height, byte[] pixels, int color_depth) {
    imgW = width;
    imgH = height;
    pixAry = pixels;
    initCodeSize = Math.max(2, color_depth);
  }

  void char_out(byte c, OutputStream outs) throws IOException {
    accum[a_count++] = c;
    if (a_count >= 254) flush_char(outs);
  }

  void cl_block(OutputStream outs) throws IOException {
    cl_hash(hsize);
    free_ent = ClearCode + 2;
    clear_flg = true;

    output(ClearCode, outs);
  }

  void cl_hash(int hsize) {
    for (int i = 0; i < hsize; ++i) htab[i] = -1;
  }

  void compress(int init_bits, OutputStream outs) throws IOException {
    int fcode;
    int i;
    int c;
    int ent;
    int disp;
    int hsize_reg;
    int hshift;

    g_init_bits = init_bits;

    clear_flg = false;
    n_bits = g_init_bits;
    maxcode = MAXCODE(n_bits);

    ClearCode = 1 << (init_bits - 1);
    EOFCode = ClearCode + 1;
    free_ent = ClearCode + 2;

    a_count = 0;

    ent = nextPixel();

    hshift = 0;
    for (fcode = hsize; fcode < 65536; fcode *= 2) ++hshift;
    hshift = 8 - hshift;

    hsize_reg = hsize;
    cl_hash(hsize_reg);

    output(ClearCode, outs);

    outer_loop:
    while ((c = nextPixel()) != EOF) {
      fcode = (c << maxbits) + ent;
      i = (c << hshift) ^ ent;

      if (htab[i] == fcode) {
        ent = codetab[i];
        continue;
      } else if (htab[i] >= 0) {
        disp = hsize_reg - i;
        if (i == 0) disp = 1;
        do {
          if ((i -= disp) < 0) i += hsize_reg;

          if (htab[i] == fcode) {
            ent = codetab[i];
            continue outer_loop;
          }
        } while (htab[i] >= 0);
      }
      output(ent, outs);
      ent = c;
      if (free_ent < maxmaxcode) {
        codetab[i] = free_ent++;
        htab[i] = fcode;
      } else cl_block(outs);
    }
    output(ent, outs);
    output(EOFCode, outs);
  }

  void encode(OutputStream os) throws IOException {
    os.write(initCodeSize);

    remaining = imgW * imgH;
    curPixel = 0;

    compress(initCodeSize + 1, os);

    os.write(0);
  }

  void flush_char(OutputStream outs) throws IOException {
    if (a_count > 0) {
      outs.write(a_count);
      outs.write(accum, 0, a_count);
      a_count = 0;
    }
  }

  final int MAXCODE(int n_bits) {
    return (1 << n_bits) - 1;
  }

  private int nextPixel() {
    if (remaining == 0) return EOF;

    --remaining;

    byte pix = pixAry[curPixel++];

    return pix & 0xff;
  }

  void output(int code, OutputStream outs) throws IOException {
    cur_accum &= masks[cur_bits];

    if (cur_bits > 0) cur_accum |= (code << cur_bits);
    else cur_accum = code;

    cur_bits += n_bits;

    while (cur_bits >= 8) {
      char_out((byte) (cur_accum & 0xff), outs);
      cur_accum >>= 8;
      cur_bits -= 8;
    }

    if (free_ent > maxcode || clear_flg) {
      if (clear_flg) {
        maxcode = MAXCODE(n_bits = g_init_bits);
        clear_flg = false;
      } else {
        ++n_bits;
        if (n_bits == maxbits) maxcode = maxmaxcode;
        else maxcode = MAXCODE(n_bits);
      }
    }

    if (code == EOFCode) {
      while (cur_bits > 0) {
        char_out((byte) (cur_accum & 0xff), outs);
        cur_accum >>= 8;
        cur_bits -= 8;
      }

      flush_char(outs);
    }
  }
}
