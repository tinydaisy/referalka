import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const accountId = process.env.CF_ACCOUNT_ID
  const accessKeyId = process.env.CF_R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.CF_R2_SECRET_ACCESS_KEY
  const bucketName = process.env.CF_R2_BUCKET_NAME || 'referalka'
  const publicUrl = process.env.CF_R2_PUBLIC_URL || 'https://pub-519fc43b54e1489384397c9cea0c0ded.r2.dev'

  if (!accessKeyId || !secretAccessKey || !accountId) {
    return NextResponse.json({ error: 'R2 not configured' }, { status: 500 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const type = formData.get('type') as string || 'horizontal'
  const eventId = req.nextUrl.searchParams.get('event_id')

  if (!file) {
    return NextResponse.json({ error: 'No file' }, { status: 400 })
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const filename = `posters/event_${eventId}/${type}_${Date.now()}.${ext}`

  // Upload to R2 via S3-compatible API
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  const buffer = Buffer.from(await file.arrayBuffer())

  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: filename,
    Body: buffer,
    ContentType: file.type || 'image/jpeg',
  }))

  const url = `${publicUrl}/${filename}`
  return NextResponse.json({ url })
}
